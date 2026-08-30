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
  // 0072: the SHORT reconnect grace before a non-terminal-ending phone session
  // is partial-finalized. Read functionally through the injectable `source`
  // below; this literal keeps it visible to `check-env-contract.mjs`.
  process.env.PHONE_PARTIAL_FINALIZE_GRACE_SEC,
];
void _contractVisibleEnvReads;

/** The durable queue this runtime drains. `0042` enqueues into it by name. */
export const PHONE_DIAL_QUEUE = 'phone.dial';
/** Durable scoring work; it is safe to claim while phone dialing is halted. */
export const PHONE_ASSESSMENT_QUEUE = 'phone.assessment';
export const phoneAssessmentDedupKey = (sessionId: string): string =>
  `${PHONE_ASSESSMENT_QUEUE}:${sessionId}`;

export interface PhoneRuntimeBound {
  readonly def: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Every bound, in one table so the clamps are reviewable together.
 *
 * The four cadences ESCALATE, ordered by cost rather than by importance:
 * due 15s < reclaim 30s < reconcile 60s < expire 120s. Dialling is the
 * cheapest read and the only one a candidate is waiting on; reconciling costs
 * a LiveKit room read per live attempt; expiring an appointment can wait.
 *
 * ── THE ONE CORRECTNESS BOUND, STATED IN TERMS OF THE SCHEDULER ──────
 * `reclaimMs` against the attempt lease. `PHONE_BOUNDS.leaseSeconds` defaults
 * to 60s. Let the sweep grow slower than the lease and a dead worker's fleet
 * slot is held for the difference, against every other candidate — which is
 * the starvation 0042 says this loop exists to prevent.
 *
 * The bound is a statement about the SCHEDULER, not about this table, and the
 * two are not the same thing. `lib/scheduler.ts` computes each delay as
 * `nextPollDelayMs(base, idle, random)` = `min(base · 2^idle, 60_000) · [0.5,
 * 1.0)`, and an idle `phone-reclaim` — reclaiming nothing is its STEADY STATE
 * — used to drift to the 60s ceiling. The comment here claimed a 30s sweep and
 * half a lease-lifetime; the reality was 30–60s and up to a FULL one. The old
 * assertion beneath this comment compared two constants in this table while
 * the thing that decided the cadence was not in the comparison at all, so the
 * false claim could not have been caught by changing either of them.
 *
 * `runtime.ts` therefore holds `phone-reclaim` (and `phone-due`, for the
 * reconnect bound — see M-4 there) at the base cadence: `idle` stays 0, so
 * every interval is `reclaimMs · [0.5, 1.0)` and the sweep runs AT LEAST once
 * per `reclaimMs`. That gives the two-part bound now asserted in
 * `phone-runtime-core.test.ts` (the arithmetic, against
 * `PHONE_BOUNDS.leaseSeconds`) and in `phone-runtime-loops.test.ts` (the
 * behaviour: the observed interval of an idle `phone-reclaim`, measured
 * against the scheduler, never exceeds `reclaimMs`):
 *
 *     reclaimMs · 2  ≤  leaseSeconds · 1000
 *
 * i.e. a lapsed lease is seen within half a lease-lifetime. Error backoff is
 * untouched: a throwing sweep still backs off, because a throw never produces
 * the "did work" answer that pins the cadence.
 *
 * (An earlier version of this comment claimed reclaim was "faster than the
 * due cadence is slow". It is not — 30s against 15s — and the test beneath it
 * compared reclaim to RECONCILE, so the false claim went unchecked.)
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
  /** Rows touched per pass by EITHER bounded sweep — the attempt-lease reclaim and the appointment expiry share this bound. Two sweeps, one knob: raising it for a lease backlog also widens the expiry batch. */
  reclaimLimit: { def: 25, min: 1, max: 200 },
  /** Lease seconds for the `phone.dial` QUEUE job — not the attempt lease. */
  jobLeaseSeconds: { def: 60, min: 5, max: 900 },
  /**
   * 0072. SHORT reconnect grace (SECONDS) before a phone session that ended
   * non-terminally is partial-finalized. It must be far BELOW 0071's stranded
   * 7200s so this wins the race for a genuinely-ended call and delivers the
   * scorecard first; the max clamps it under that ceiling. The min keeps a
   * brief network hiccup from being finalized as a disconnect.
   */
  partialFinalizeGraceSec: { def: 180, min: 30, max: 7200 },
});

export interface PhoneRuntimeConfig {
  readonly dueMs: number;
  readonly reclaimMs: number;
  readonly reconcileMs: number;
  readonly expireMs: number;
  readonly dueLimit: number;
  readonly reclaimLimit: number;
  readonly jobLeaseSeconds: number;
  /** 0072. Reconnect grace (seconds) before a partial-finalize. */
  readonly partialFinalizeGraceSec: number;
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
    partialFinalizeGraceSec: boundedInt(
      source.PHONE_PARTIAL_FINALIZE_GRACE_SEC, b.partialFinalizeGraceSec!,
    ),
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
    partial_finalize_grace_sec: config.partialFinalizeGraceSec,
  };
}
