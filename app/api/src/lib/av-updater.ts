/**
 * av-updater.ts — the ClamAV signature update lifecycle.
 *
 * WHY THE IMAGE SHIPS WITHOUT SIGNATURES
 * --------------------------------------
 * The previous image ran `(freshclam --quiet || true)` once at build time. That
 * had two independent defects. The `|| true` meant a failed download produced a
 * green build with an EMPTY database directory, and even a successful download
 * froze the signatures at image-build time — a container running for three
 * weeks screened resumes against three-week-old signatures forever, because the
 * runtime is non-root and had no updater at all.
 *
 * The fix is not to make the build-time download mandatory. ClamAV's CDN
 * rate-limits datacentre egress hard (HTTP 429), so a mandatory `freshclam` in
 * the build turns every image build into a coin flip against a third party —
 * trading a silent security failure for a flaky, non-deterministic build. So
 * the image bakes NO database at all, and this module owns the whole lifecycle
 * at runtime:
 *
 *   - one update attempt at container start, and
 *   - a periodic refresh thereafter,
 *
 * both bounded, both non-root, both without a daemon or a socket (the scanner
 * invokes `clamscan` directly, so there is no `clamd` to notify).
 *
 * This removes the stale-signature failure mode structurally: there is no baked
 * database that can quietly age, and an image whose updater never succeeds has
 * NO database, which `clamav-signatures.ts` reports as `signatures_missing` and
 * the scanner rejects. The window between container start and the first
 * successful update is therefore fail-closed rather than fail-quiet: resume
 * ingestion is refused, and the health surface says exactly why.
 *
 * A FAILED UPDATE MUST NOT CRASH-LOOP THE API.
 * The API serves interviews, invites, recordings and dashboards; none of that
 * depends on the malware scanner. Exiting on a failed download would convert a
 * degraded resume path into a total outage, and Fly would restart-loop into the
 * same rate limit. So an update failure is recorded, surfaced, and retried on
 * the next tick — never thrown, and never fatal. Truthfulness is preserved by
 * the scanner and the health surface, not by killing the process.
 */

import { execFile } from 'node:child_process';

import { createLogger } from './logger.js';

// Keep the env names visible to the env-contract checker, which scans for
// `process.env.<VAR>` literals.
const _contractVisibleEnvReads = [
  process.env.AV_UPDATER_INTERVAL_MS,
  process.env.AV_UPDATER_TIMEOUT_MS,
];
void _contractVisibleEnvReads;

const updaterLogger = createLogger('av-updater');

/** The updater binary. Not configurable: it is an image-owned build artefact. */
export const FRESHCLAM_BIN = 'freshclam';

/** Image-owned, root-owned, read-only updater configuration. */
export const FRESHCLAM_CONFIG = '/etc/clamav/freshclam.conf';

/**
 * Bounds for every tunable. Inputs are clamped, never trusted.
 *
 * The interval floor is 15 minutes because ClamAV asks clients not to poll
 * more often than that; the default of one hour sits comfortably inside the
 * 24-hour freshness ceiling with room for ~23 consecutive failures before a
 * scan is refused. The timeout default of 10 minutes covers a cold start, when
 * `main` (~89 MB) and `daily` (~23 MB) are both downloaded from scratch.
 */
export const AV_UPDATER_BOUNDS = {
  intervalMs: { def: 3_600_000, min: 900_000, max: 43_200_000 },
  timeoutMs: { def: 600_000, min: 60_000, max: 1_800_000 },
} as const;

/**
 * COLD-START retry ladder, used only while the machine holds NO usable
 * signature database at all.
 *
 * The steady-state interval and its 15-minute floor are ClamAV's politeness
 * request about TOPPING UP a database you already have. They are the wrong
 * cadence for a machine that cannot scan anything: with a single hourly
 * schedule, one lost cold-start attempt — a timeout, a 429 — meant a full hour
 * during which every resume ingestion arrived at a scanner with nothing to
 * screen with. That hour is the difference between a deferral nobody notices
 * and a backlog somebody has to explain.
 *
 * Each individual attempt is still bounded by freshclam's own `MaxAttempts 3`
 * and by `timeoutMs`, and the updater remains single-flight, so a short ladder
 * cannot become a request storm. The ladder is escalating and capped, and the
 * moment a database exists the steady-state interval takes over.
 */
export const AV_COLD_RETRY_MS: readonly number[] = [60_000, 120_000, 300_000];

export interface AvUpdaterConfig {
  /** True iff ClamAV is the configured production scanner. */
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
}

function bounded(raw: string | undefined, bound: { def: number; min: number; max: number }): number {
  if (typeof raw !== 'string' || !/^\d{1,12}$/.test(raw.trim())) return bound.def;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) return bound.def;
  return n < bound.min ? bound.min : n > bound.max ? bound.max : n;
}

/**
 * Load the updater configuration.
 *
 * The updater is bound to the scanner selection rather than to a flag of its
 * own: it runs exactly when `RESUME_SCANNER=clamav`, so there is no way to
 * configure a ClamAV scanner with no updater behind it (which is the state
 * that produced this defect), and no way to leave an updater downloading
 * ~113 MB in a deployment that never scans.
 */
export function loadAvUpdaterConfig(source: NodeJS.ProcessEnv = process.env): AvUpdaterConfig {
  return {
    enabled: source.RESUME_SCANNER === 'clamav',
    intervalMs: bounded(source.AV_UPDATER_INTERVAL_MS, AV_UPDATER_BOUNDS.intervalMs),
    timeoutMs: bounded(source.AV_UPDATER_TIMEOUT_MS, AV_UPDATER_BOUNDS.timeoutMs),
  };
}

/** Stable, sanitized outcome codes. */
export type AvUpdateReason = 'update_failed' | 'update_timeout' | 'updater_unavailable';

export type AvUpdateOutcome =
  | { ok: true }
  | { ok: false; reason: AvUpdateReason };

export interface RunUpdateOptions {
  bin?: string;
  configFile?: string;
  timeoutMs?: number;
  /**
   * Injectable spawner (tests). Deliberately NOT named `exec`: the repo SAST
   * rule S002 flags that identifier as a shell-injection smell, and a local
   * alias that merely looks like one is not worth the ambiguity. `execFile`
   * takes an argv array and never involves a shell.
   */
  execFileImpl?: typeof execFile;
}

/**
 * Run ONE bounded update attempt. Never throws and never rejects.
 *
 * freshclam's output names mirrors and local paths, and on some failures echoes
 * server responses, so nothing from stdout/stderr is logged or returned — only
 * the stable reason code. `--stdout` keeps freshclam off stderr entirely so a
 * non-zero exit is decided by the exit code alone rather than by scraping text.
 */
export async function runAvUpdateOnce(opts: RunUpdateOptions = {}): Promise<AvUpdateOutcome> {
  const bin = opts.bin ?? FRESHCLAM_BIN;
  const configFile = opts.configFile ?? FRESHCLAM_CONFIG;
  const timeoutMs = opts.timeoutMs ?? AV_UPDATER_BOUNDS.timeoutMs.def;
  const execFileImpl = opts.execFileImpl ?? execFile;

  return new Promise<AvUpdateOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: AvUpdateOutcome): void => {
      if (settled) return;
      settled = true;
      if (!outcome.ok) {
        updaterLogger.warn('unknown_event', {
          error_category: 'av_updater',
          error_type: outcome.reason,
        });
      }
      resolve(outcome);
    };

    try {
      execFileImpl(
        bin,
        [`--config-file=${configFile}`, '--stdout'],
        { timeout: timeoutMs, maxBuffer: 256 * 1024, killSignal: 'SIGTERM' },
        (error) => {
          if (!error) { done({ ok: true }); return; }
          const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
            done({ ok: false, reason: 'update_timeout' });
            return;
          }
          if (err.code === 'ENOENT' || err.code === 'EACCES') {
            done({ ok: false, reason: 'updater_unavailable' });
            return;
          }
          done({ ok: false, reason: 'update_failed' });
        },
      );
    } catch {
      // A synchronous spawn failure (bad path, EMFILE) is still just a failure.
      done({ ok: false, reason: 'updater_unavailable' });
    }
  });
}

export interface AvUpdaterHandle {
  /** Run an attempt now, honouring the single-flight guard. */
  runNow(): Promise<AvUpdateOutcome>;
  /** Stop the periodic timer. Idempotent. Does not abort an in-flight attempt. */
  stop(): void;
  /** Attempts started, successes, and the last stable failure reason. */
  stats(): { runs: number; successes: number; failures: number; lastReason: AvUpdateReason | null };
}

export interface StartUpdaterOptions extends RunUpdateOptions {
  intervalMs: number;
  /** Run an attempt immediately on start (default true). */
  immediate?: boolean;
  /**
   * True when this machine currently has NO usable signature database — it
   * cannot scan at all, as opposed to holding one that wants topping up.
   * Defaults to "not cold", which preserves the pure steady-state cadence for
   * any caller that does not supply it.
   */
  isCold?: () => boolean | Promise<boolean>;
  /** Timer seams so the ladder is deterministic in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Jitter source in [0,1). Injected for determinism. */
  random?: () => number;
  /**
   * Injectable single attempt (tests). Defaults to the real bounded
   * `runAvUpdateOnce`, so production behaviour is unchanged; the seam exists
   * so the CADENCE can be tested without spawning freshclam.
   */
  runOnce?: () => Promise<AvUpdateOutcome>;
}

/**
 * Delay before the next attempt.
 *
 * Cold: climb the ladder, capped at its last rung, with full jitter in
 * [0.5, 1.0) so a fleet restarting together does not hit the mirror in
 * lockstep. Warm: the configured steady-state interval, unchanged.
 */
export function nextUpdateDelayMs(
  cold: boolean,
  consecutiveColdAttempts: number,
  intervalMs: number,
  random: () => number = Math.random,
): number {
  if (!cold) return intervalMs;
  const idx = Math.min(Math.max(0, consecutiveColdAttempts), AV_COLD_RETRY_MS.length - 1);
  const base = AV_COLD_RETRY_MS[idx]!;
  return Math.max(1, Math.round(base * (0.5 + random() * 0.5)));
}

/**
 * Start the periodic updater.
 *
 * SINGLE-FLIGHT BY CONSTRUCTION. A cold-start download can outlast a tick; two
 * concurrent freshclam processes writing the same database directory is exactly
 * the update race that could corrupt a scan, so a tick that fires while an
 * attempt is running is dropped rather than queued. The timer is `unref`ed so
 * it can never hold the process open past the API's own shutdown.
 */
export function startAvUpdater(opts: StartUpdaterOptions): AvUpdaterHandle {
  let inFlight: Promise<AvUpdateOutcome> | null = null;
  let stopped = false;
  let runs = 0;
  let successes = 0;
  let failures = 0;
  let lastReason: AvUpdateReason | null = null;

  const runNow = async (): Promise<AvUpdateOutcome> => {
    if (inFlight) return inFlight;
    runs += 1;
    inFlight = (opts.runOnce ? opts.runOnce() : runAvUpdateOnce(opts))
      .then((outcome) => {
        if (outcome.ok) { successes += 1; lastReason = null; }
        else { failures += 1; lastReason = outcome.reason; }
        return outcome;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  // Self-scheduling rather than a fixed interval: the delay to the NEXT
  // attempt depends on the state the LAST one left behind. Single-flight is
  // preserved by construction — the next timer is armed only after the
  // previous attempt settles, so two freshclam processes can never write the
  // same database directory concurrently.
  const setTimer = opts.setTimer
    ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      // Never hold the process open on account of the updater.
      if (typeof (t as NodeJS.Timeout).unref === 'function') (t as NodeJS.Timeout).unref();
      return t;
    });
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const random = opts.random ?? Math.random;

  let timer: unknown = null;
  let coldAttempts = 0;

  const arm = async (): Promise<void> => {
    if (stopped) return;
    let cold = false;
    try {
      cold = opts.isCold ? await opts.isCold() : false;
    } catch {
      // An unreadable database directory is indistinguishable from an absent
      // one, and both mean this machine cannot scan — retry on the urgent
      // ladder rather than an hour later.
      cold = true;
    }
    if (stopped) return;
    const delay = nextUpdateDelayMs(cold, coldAttempts, opts.intervalMs, random);
    coldAttempts = cold ? coldAttempts + 1 : 0;
    timer = setTimer(() => {
      if (stopped) return;
      // An update failure must never reach the process as an unhandled rejection.
      void runNow().catch(() => undefined).then(() => arm());
    }, delay);
  };

  if (opts.immediate !== false) {
    void runNow().catch(() => undefined).then(() => arm());
  } else {
    void arm();
  }

  return {
    runNow,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimer(timer);
    },
    stats: () => ({ runs, successes, failures, lastReason }),
  };
}
