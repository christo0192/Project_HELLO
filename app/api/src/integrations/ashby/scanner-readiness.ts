/**
 * ashby/scanner-readiness.ts — the CHEAP, machine-local proof that the resume
 * malware scanner has something to screen with, used to admit or hold back
 * `ashby.ingestion` claims.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ClamAvScanner` already fails closed on a stale or missing signature
 * database — that part was right and is not softened here. What was wrong is
 * WHERE the refusal landed. A resume ingestion claimed on a cold boot, seconds
 * after the machine started and before freshclam had finished its first
 * download, ran the whole pipeline (provider `file.info` → presigned URL →
 * download the candidate's resume) and only then discovered there was nothing
 * to screen with. The result was a durable `failed_review`, one attempt spent,
 * and a resume fetched for no reason. Nothing about that job was faulty. With
 * no persistent database directory and `auto_stop_machines`, that cold window
 * recurs on every deploy, autostart, crash and machine replacement.
 *
 * WHY FRESHNESS ONLY, AND NOT THE CAPABILITY PROBE
 * ------------------------------------------------
 * The obvious move is to reuse Mission Control's full readiness view. It is
 * the wrong one. That view runs `probeClamAvCapability`, which executes the
 * real `clamscan` behind the process-wide gate that production scans also
 * take. Putting it on a poll path would let readiness checks compete with the
 * very scans they are protecting, and a gate acquisition can wait as long as
 * the scan timeout — long enough to lose the lease it was supposed to protect.
 *
 * The freshness reader is the right primitive: a 512-byte header read behind a
 * short TTL, no subprocess, no gate, no network. It answers the only question
 * an admission gate needs — "does a usable signature database exist right
 * now?" — and it answers it for THIS machine, which is exactly the scope of
 * the fact. Capability remains where its cost is affordable and its answer is
 * cached: the health surface.
 *
 * The two cannot disagree in a dangerous direction. Freshness is a NECESSARY
 * condition for readiness and health checks it first, so this gate admits a
 * strict superset of what health calls ready. Everything it admits and health
 * would not is still fail-closed at scan time, and now DEFERS rather than
 * failing.
 */

import {
  defaultSignatureFreshnessReader,
  type SignatureFreshnessReader,
  type SignatureState,
} from '../../lib/clamav-signatures.js';
import { scannerMode } from './runtime-health.js';

/** Whether this machine should start resume-ingestion work right now. */
export type ScannerGateVerdict =
  | { action: 'proceed'; mode: ReturnType<typeof scannerMode> }
  | { action: 'defer'; mode: ReturnType<typeof scannerMode>; reasonCode: string };

/**
 * Bound on the freshness read. It is a small file read and cannot normally
 * approach this, but a wedged filesystem must not hold a poll loop or a lease.
 */
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

/** Reason recorded when the freshness read did not answer in time. */
export const READINESS_TIMEOUT_REASON = 'scanner_readiness_timeout';
/** Reason recorded when the freshness read threw (it is written not to). */
export const READINESS_UNKNOWN_REASON = 'scanner_readiness_unknown';
/** Reason recorded when ClamAV is not fresh and reports no reason at all. */
export const READINESS_NOT_READY_REASON = 'scanner_not_ready';

export interface ScannerGateOptions {
  /** Env map (injectable for tests). */
  source?: NodeJS.ProcessEnv;
  /** Cheap freshness probe; defaults to the shared TTL-cached reader. */
  freshness?: SignatureFreshnessReader;
  /** Bound on the freshness read (ms). */
  timeoutMs?: number;
  /** Timer seams so the bound is deterministic in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Turn a freshness reason into a bounded, sanitized deferral code.
 *
 * The signature reasons are already stable snake_case tokens
 * (`signatures_missing`, `signatures_stale`, …). They are namespaced so a
 * queue-level reason always names WHICH prerequisite is missing, and
 * shape-checked against the same allowlist the queue and the 0037 RPC
 * enforce — an unrecognised token degrades to a fixed code rather than
 * reaching a durable column.
 */
export function scannerDeferReason(reason: string | null | undefined): string {
  if (typeof reason !== 'string' || reason.length === 0) return READINESS_NOT_READY_REASON;
  const code = (reason.startsWith('scanner_') ? reason : `scanner_${reason}`).slice(0, 64);
  return /^[a-z0-9_.:-]{1,64}$/.test(code) ? code : READINESS_NOT_READY_REASON;
}

/**
 * Decide whether ingestion work may start on this machine.
 *
 * MODE POLICY — explicit, because a deferral is only right for a condition
 * that clears on its own:
 *
 *  - `clamav` + fresh signatures → proceed.
 *  - `clamav` + not fresh        → HOLD. Missing, unreadable, corrupt or stale
 *                                  signatures all clear once freshclam
 *                                  succeeds, with no human involved.
 *  - `test`                      → proceed. The built-in test scanner is not
 *                                  production evidence and has no database; a
 *                                  gate on it would stop every non-production
 *                                  environment from ingesting anything.
 *  - `fail-closed`               → proceed. No scanner is configured, and no
 *                                  amount of waiting changes that. The scan
 *                                  fails closed as before; the availability
 *                                  classification then defers it under a
 *                                  wall-clock deadline, so it surfaces as a
 *                                  loud failure rather than an invisible
 *                                  queue that waits forever.
 */
export async function checkScannerReadiness(
  options: ScannerGateOptions = {},
): Promise<ScannerGateVerdict> {
  const source = options.source ?? process.env;
  const mode = scannerMode(source);
  if (mode !== 'clamav') return { action: 'proceed', mode };

  const freshness = options.freshness ?? defaultSignatureFreshnessReader();
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_READINESS_TIMEOUT_MS;
  const setTimer = options.setTimer
    ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      // A readiness probe must never hold the process open at shutdown.
      if (typeof (t as NodeJS.Timeout).unref === 'function') (t as NodeJS.Timeout).unref();
      return t;
    });
  const clearTimer = options.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

  let timer: unknown = null;
  let state: SignatureState | null = null;
  try {
    state = await Promise.race<SignatureState | null>([
      freshness(),
      new Promise<null>((resolve) => { timer = setTimer(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    // The reader is written not to throw. If it somehow does, that is an
    // ABSENCE of proof, which is a wait — never a licence to scan.
    return { action: 'defer', mode, reasonCode: READINESS_UNKNOWN_REASON };
  } finally {
    if (timer !== null) clearTimer(timer);
  }

  if (state === null) return { action: 'defer', mode, reasonCode: READINESS_TIMEOUT_REASON };
  if (state.fresh) return { action: 'proceed', mode };
  return { action: 'defer', mode, reasonCode: scannerDeferReason(state.reason) };
}
