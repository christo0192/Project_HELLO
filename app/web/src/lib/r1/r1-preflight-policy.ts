/**
 * The R1 audio and video preflight (`r1-av-v1`, plan section 4 step 5).
 *
 * The device check publishes the real microphone and camera tracks to a
 * disposable room and reads the sender's own counters. It passes only when a
 * stable window elapsed with no reconnects and the sender really transmitted
 * at least 50 audio packets and 45 video frames (three seconds of video at the
 * 15 fps the interview publishes). The evaluator is pure and never falls back:
 * an explicit failing metric is a failure.
 *
 * The counters are POLLED, not sampled once. A camera in a dim room, an encoder
 * that is still ramping and ICE that connects late all deliver fewer frames in
 * the first few seconds without the uplink being bad, and every failed check
 * spends one of the candidate's 3-a-minute and 10-per-link preflights. So the
 * check passes the moment both thresholds are met (after the minimum stable
 * window) and fails only at a deadline that still fits the 10 second room.
 */

export const R1_PREFLIGHT_POLICY = 'r1-av-v1' as const;

export const R1_PREFLIGHT_LIMITS = Object.freeze({
  /** The least time both tracks must stay published: 45 frames at 15 fps. */
  stableMs: 3_000,
  /** Poll the sender counters this often. */
  pollMs: 500,
  /** Fail only here, if the thresholds have still not been met. */
  deadlineMs: 8_000,
  audioPackets: 50,
  videoFrames: 45,
  /** Time the level meter must have heard the candidate during the mic check. */
  audibleMs: 750,
  /** Upper bound on connecting to the preflight room. */
  connectTimeoutMs: 10_000,
});

export interface R1PreflightMetrics {
  stableMs: number;
  reconnects: number;
  audioPackets: number;
  videoFrames: number;
  audibleMs: number;
}

export type R1PreflightFailure =
  | 'stable_window'
  | 'reconnects'
  | 'outbound_audio'
  | 'outbound_video'
  | 'microphone';

export type R1PreflightVerdict = { ok: true } | { ok: false; reason: R1PreflightFailure };

export function evaluateR1Preflight(metrics: R1PreflightMetrics): R1PreflightVerdict {
  if (metrics.stableMs < R1_PREFLIGHT_LIMITS.stableMs) {
    return { ok: false, reason: 'stable_window' };
  }
  if (metrics.reconnects > 0) return { ok: false, reason: 'reconnects' };
  if (metrics.audioPackets < R1_PREFLIGHT_LIMITS.audioPackets) {
    return { ok: false, reason: 'outbound_audio' };
  }
  if (metrics.videoFrames < R1_PREFLIGHT_LIMITS.videoFrames) {
    return { ok: false, reason: 'outbound_video' };
  }
  if (metrics.audibleMs < R1_PREFLIGHT_LIMITS.audibleMs) {
    return { ok: false, reason: 'microphone' };
  }
  return { ok: true };
}

/** Total frames sent across every layer; simulcast is off, but sum defensively. */
export function sumVideoFrames(stats: ReadonlyArray<{ framesSent?: number }> | undefined): number {
  return (stats ?? []).reduce((total, layer) => total + (layer.framesSent ?? 0), 0);
}

export interface R1PreflightCounters {
  audioPackets: number;
  videoFrames: number;
}

export interface R1PreflightWindow {
  /** A monotonic clock in milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The sender's own counters, read from the published tracks. */
  readCounters: () => Promise<R1PreflightCounters>;
  /** Reconnects seen so far. */
  reconnects: () => number;
  /** How long the microphone check heard the candidate. */
  audibleMs: number;
  /** True once the check was abandoned; the loop then stops and reports nothing. */
  cancelled: () => boolean;
}

/** Failures that more waiting cannot cure: report them at once rather than at the deadline. */
const FINAL_FAILURES: ReadonlySet<R1PreflightFailure> = new Set<R1PreflightFailure>([
  'reconnects',
  'microphone',
]);

/**
 * Poll the counters every `pollMs` from the moment the tracks were published
 * and return the verdict: `ok` as soon as the thresholds are met after the
 * stable window, a final failure (a reconnect, an inaudible microphone) at
 * once, otherwise the failing verdict at `deadlineMs`. Returns null if the check
 * was cancelled.
 */
export async function waitForR1Preflight(
  check: R1PreflightWindow,
): Promise<R1PreflightVerdict | null> {
  const startedAt = check.now();
  for (;;) {
    await check.sleep(R1_PREFLIGHT_LIMITS.pollMs);
    if (check.cancelled()) return null;
    const counters = await check.readCounters();
    if (check.cancelled()) return null;
    const reconnects = check.reconnects();
    if (reconnects > 0) return { ok: false, reason: 'reconnects' };
    const elapsedMs = check.now() - startedAt;
    const verdict = evaluateR1Preflight({
      stableMs: elapsedMs,
      reconnects,
      audibleMs: check.audibleMs,
      ...counters,
    });
    if (verdict.ok) return verdict;
    if (FINAL_FAILURES.has(verdict.reason)) return verdict;
    if (elapsedMs >= R1_PREFLIGHT_LIMITS.deadlineMs) return verdict;
  }
}
