/**
 * lib/phone-runtime/config.ts — the cadence and batch bounds for the phone
 * runtime loops. Nothing here decides WHETHER the lane may dial; that is
 * `lib/phone-screening/config.ts` and, under the advisory lock, `0042` itself.
 * This file decides only how often we ask and how much we take per pass.
 *
 * ── WHY THIS DIRECTORY EXISTS AT ALL ──────────────────────────────────
 * The obvious home for a phone runtime is `lib/phone-screening/`, and it is
 * the wrong one. That package carries a directory-wide structural assertion
 * that no file in it may contain `setInterval(`, `setTimeout(` or
 * `setImmediate(`, and that every import is either relative or
 * `@supabase/supabase-js`. A worker loop, a heartbeat and the queue library
 * are all inadmissible there — by design, because the domain core is a set of
 * pure decisions and adapters that a request can drive.
 *
 * So the runtime lives beside it and imports it, exactly as
 * `lib/recording/runtime.ts` sits beside the recording domain. Every file here
 * that imports the phone domain core is registered in the ALLOWED_IMPORTERS
 * bijection in `phone-screening-structural.test.ts`; that set is asserted in
 * both directions, so a file added here without registering fails, and a
 * registration left behind after a file is deleted fails too.
 *
 * ── EVERY KNOB IS CLAMPED AND NONE IS FATAL ───────────────────────────
 * A malformed value reads as the default rather than throwing. A runtime that
 * refuses to start because someone typed `PHONE_RUNTIME_DUE_MS=fast` is a
 * runtime that stops reclaiming leases, and a stuck lease holds one of ten
 * fleet slots until a human notices.
 *
 * Importing this module performs NO I/O, opens NO connection and arms NO
 * timer; the loader takes an injectable `source` map.
 */

// Keep the env names visible to `scripts/check-env-contract.mjs`, which scans
// for literal `process.env.<VAR>` reads. The functional reads all go through
// the injectable `source` map below.
const _contractVisibleEnvReads = [
  process.env.PHONE_RUNTIME_DUE_MS,
  process.env.PHONE_RUNTIME_RECLAIM_MS,
  process.env.PHONE_RUNTIME_RECONCILE_MS,
  process.env.PHONE_RUNTIME_EXPIRE_MS,
  process.env.PHONE_RUNTIME_DUE_LIMIT,
  process.env.PHONE_RUNTIME_RECLAIM_LIMIT,
  process.env.PHONE_RUNTIME_JOB_LEASE_SECONDS,
];
void _contractVisibleEnvReads;

/** The durable queue this runtime drains. `0042` enqueues into it by name. */
export const PHONE_DIAL_QUEUE = 'phone.dial';

export interface PhoneRuntimeBound {
  readonly def: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Every bound, in one table so the clamps are reviewable together.
 *
 * The reclaim cadence is deliberately FASTER than the due cadence is slow: a
 * lease that has lapsed is holding one of ten fleet slots against every other
 * candidate, whereas a due engagement that waits one extra tick has lost
 * nothing. When in doubt this runtime reclaims sooner and dials later.
 */
export const PHONE_RUNTIME_BOUNDS: Readonly<Record<string, PhoneRuntimeBound>> = Object.freeze({
  /** How often the due sweep looks for an engagement to dial. */
  dueMs: { def: 15_000, min: 1_000, max: 300_000 },
  /** How often expired ATTEMPT leases are reclaimed (the fleet-slot lease). */
  reclaimMs: { def: 30_000, min: 5_000, max: 600_000 },
  /** How often the dropped-webhook sweep runs. */
  reconcileMs: { def: 60_000, min: 10_000, max: 900_000 },
  /** How often overdue appointments are expired. */
  expireMs: { def: 120_000, min: 10_000, max: 900_000 },
  /**
   * Engagements dialled per due pass. Small on purpose: each one is a call to
   * a person, the fleet cap is ten, and a burst that exhausts the cap makes
   * every other admission answer `at_capacity`.
   */
  dueLimit: { def: 3, min: 1, max: 25 },
  /** Attempt leases reclaimed per pass. */
  reclaimLimit: { def: 25, min: 1, max: 200 },
  /** Lease seconds for the `phone.dial` QUEUE job — not the attempt lease. */
  jobLeaseSeconds: { def: 60, min: 5, max: 900 },
});

export interface PhoneRuntimeConfig {
  readonly dueMs: number;
  readonly reclaimMs: number;
  readonly reconcileMs: number;
  readonly expireMs: number;
  readonly dueLimit: number;
  readonly reclaimLimit: number;
  readonly jobLeaseSeconds: number;
}

/**
 * Parse and clamp. A value that is not a plain run of up to twelve digits
 * yields the default; anything else is clamped into its bound. Never throws,
 * never fatal.
 */
function boundedInt(raw: string | undefined, bound: PhoneRuntimeBound): number {
  const trimmed = (raw ?? '').trim();
  if (!/^\d{1,12}$/.test(trimmed)) return bound.def;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return bound.def;
  return Math.min(bound.max, Math.max(bound.min, parsed));
}

export function loadPhoneRuntimeConfig(
  source: NodeJS.ProcessEnv = process.env,
): PhoneRuntimeConfig {
  const b = PHONE_RUNTIME_BOUNDS;
  return Object.freeze({
    dueMs: boundedInt(source.PHONE_RUNTIME_DUE_MS, b.dueMs!),
    reclaimMs: boundedInt(source.PHONE_RUNTIME_RECLAIM_MS, b.reclaimMs!),
    reconcileMs: boundedInt(source.PHONE_RUNTIME_RECONCILE_MS, b.reconcileMs!),
    expireMs: boundedInt(source.PHONE_RUNTIME_EXPIRE_MS, b.expireMs!),
    dueLimit: boundedInt(source.PHONE_RUNTIME_DUE_LIMIT, b.dueLimit!),
    reclaimLimit: boundedInt(source.PHONE_RUNTIME_RECLAIM_LIMIT, b.reclaimLimit!),
    jobLeaseSeconds: boundedInt(source.PHONE_RUNTIME_JOB_LEASE_SECONDS, b.jobLeaseSeconds!),
  });
}

/**
 * Publishable shape. Integers and nothing else — no identifier, no credential,
 * no digest, and nothing derived from a candidate.
 */
export function describePhoneRuntimeConfig(
  config: PhoneRuntimeConfig,
): Record<string, number> {
  return {
    due_ms: config.dueMs,
    reclaim_ms: config.reclaimMs,
    reconcile_ms: config.reconcileMs,
    expire_ms: config.expireMs,
    due_limit: config.dueLimit,
    reclaim_limit: config.reclaimLimit,
    job_lease_seconds: config.jobLeaseSeconds,
  };
}
