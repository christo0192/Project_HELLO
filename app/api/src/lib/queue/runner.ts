/**
 * lib/queue/runner.ts — a bounded, lease-safe consumer for the leased queue.
 *
 * The repository had no queue consumer of any kind: `Queue.claim` existed with
 * no caller, so a durably enqueued job was never processed. This is that
 * consumer, kept generic (a handler map keyed by queue name) so the Ashby
 * signal / import / ingestion queues all share one audited implementation.
 *
 * GUARANTEES
 *  - Every mutation is a compare-and-set on the LIVE lease. A runner whose
 *    lease expired or was reclaimed commits nothing (`completeClaim` → false).
 *  - Bounded in-flight work: never more than `concurrency` simultaneous claims.
 *  - Long jobs heartbeat at a fraction of the lease so a slow-but-alive worker
 *    does not lose its lease mid-flight; a lost heartbeat stops the job rather
 *    than letting it commit later.
 *  - A throwing handler fails the job UNDER the lease (retry with backoff, then
 *    DLQ at `maxAttempts`) — it never escapes and kills the loop.
 *  - Empty-queue and error polling both back off geometrically to a bounded
 *    ceiling, so an idle or broken queue cannot hot-spin.
 *  - `stop()` is idempotent, stops claiming NEW work immediately, and resolves
 *    only after in-flight handlers settle.
 *
 * MULTI-MACHINE: correctness comes from the DB lease (FOR UPDATE SKIP LOCKED +
 * CAS), never from an assumption about how many processes are running. Two
 * runners on two machines are safe by construction; the poll delay is jittered
 * so they do not synchronise into a thundering herd.
 */

import type { Queue } from './index.js';
import type { QueueJob } from './types.js';
import { clampDeferSeconds, isValidDeferReason, DEFAULT_DEFER_SECONDS } from './types.js';

/**
 * An explicit, typed request to DEFER this job instead of completing or
 * failing it: the work never started because a prerequisite was not met.
 *
 * This is deliberately a RETURN VALUE and not a thrown sentinel. A throw is
 * how a handler reports failure, and the entire point of a deferral is that it
 * is not one — routing it through the same channel is exactly how "waiting"
 * gets charged against a failure budget.
 */
export interface QueueDeferDirective {
  outcome: 'defer';
  /** Sanitized snake_case reason code (allowlist-checked before use). */
  reasonCode: string;
  /** Delay before the job becomes claimable again; clamped to [1, 3600]s. */
  delaySeconds?: number;
}

/** What a handler may return. `void` keeps every existing handler valid. */
export type QueueHandlerResult = void | QueueDeferDirective;

/** A handler processes exactly one job. Throwing fails the job under lease. */
export type QueueHandler = (job: QueueJob<unknown>) => Promise<QueueHandlerResult>;

/** Reason recorded when a handler asks to defer with an unusable code. */
export const FALLBACK_DEFER_REASON = 'prerequisite_not_ready';

/** Narrow a handler return value to a defer directive. */
export function isDeferDirective(value: QueueHandlerResult): value is QueueDeferDirective {
  return Boolean(value) && (value as QueueDeferDirective).outcome === 'defer';
}

/** Fallback code for anything that is not already a sanitized token. */
export const UNKNOWN_ERROR_CODE = 'unknown_error';

/** Maximum length of a persisted error code. */
const MAX_ERROR_CODE_LEN = 64;

/**
 * Reduce a thrown value to a bounded, sanitized code before it is persisted to
 * `job_queue.error_message` and the DLQ.
 *
 * Every current throw site already uses a stable snake_case token
 * (`ashby_link_read_error`, `malformed_import_payload`, …), but nothing
 * enforced it: a future `TypeError`, or a driver error carrying row content or
 * a connection string, would have been written verbatim to a durable column
 * (review finding L2). This is the enforcement — shape-checked allowlisting,
 * not a denylist, so an unanticipated message can never pass.
 */
export function sanitizeErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // A sanitized code is lowercase snake/dotted/dashed ASCII of bounded length.
  // Anything with whitespace, punctuation, digits-as-data, or non-ASCII fails.
  if (/^[a-z][a-z0-9_.:-]{2,63}$/.test(raw) && raw.length <= MAX_ERROR_CODE_LEN) {
    return raw;
  }
  return UNKNOWN_ERROR_CODE;
}

export interface QueueRunnerOptions {
  queue: Pick<Queue, 'claim' | 'completeClaim' | 'failClaim' | 'heartbeat' | 'deferClaim'>;
  /** Queue name → handler. A job whose name has no handler is failed closed. */
  handlers: Readonly<Record<string, QueueHandler>>;
  /** Opaque worker identity recorded as the lease owner. Never a secret. */
  owner: string;
  /** Visibility window granted per claim (seconds). Clamped by the Queue. */
  leaseSeconds: number;
  /** Max simultaneous in-flight jobs. Clamped to [1,32]. */
  concurrency?: number;
  /** Base delay between polls when work was found (ms). */
  pollMs: number;
  /**
   * ADMISSION GATE, consulted before each claim on a queue (R-2).
   *
   * Returning false means this machine does not claim from that queue right
   * now. The job stays `pending`: no attempt is spent, no lease churns, no
   * provider call is made, no bytes are downloaded — and a DIFFERENT machine
   * whose prerequisite IS satisfied can take it, which no post-claim outcome
   * can express.
   *
   * It is deliberately advisory, not authoritative: a prerequisite can lapse
   * between the check and the work, which is what the lease-safe deferral is
   * for. Anything it consults must be CHEAP — it runs on every poll of every
   * queue. A throw is treated as "do not claim", never as permission.
   */
  shouldClaim?: (queueName: string) => boolean | Promise<boolean>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable jitter source in [0,1). Inject for determinism. */
  random?: () => number;
  /** Metadata-only observer. Must never receive payloads or lease tokens. */
  onEvent?: (event: QueueRunnerEvent) => void;
}

export interface QueueRunnerEvent {
  kind: 'claimed' | 'completed' | 'deferred' | 'not_admitted' | 'failed' | 'stale_lease' | 'no_handler' | 'poll_error';
  queueName: string;
  /** Sanitized stable code only — never a provider message or payload. */
  code?: string;
}

export interface QueueRunnerHandle {
  /** Run one poll pass over every configured queue. Returns jobs processed. */
  tick(): Promise<number>;
  /** True while at least one handler is in flight. */
  inFlight(): number;
  /** Peak simultaneous in-flight jobs observed (test/observability aid). */
  peakInFlight(): number;
  /** Stop claiming new work and resolve once in-flight handlers settle. */
  stop(): Promise<void>;
  /** True once stop() has been called. */
  stopped(): boolean;
}

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;

function clampConcurrency(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return 2;
  return v < MIN_CONCURRENCY ? MIN_CONCURRENCY : v > MAX_CONCURRENCY ? MAX_CONCURRENCY : v;
}

/**
 * Build a runner. Nothing polls until `tick()` is driven — the scheduler owns
 * the cadence, so this module stays fully testable with no timers at all.
 */
export function createQueueRunner(options: QueueRunnerOptions): QueueRunnerHandle {
  const concurrency = clampConcurrency(options.concurrency);
  const queueNames = Object.keys(options.handlers);
  const emit = (event: QueueRunnerEvent): void => {
    if (!options.onEvent) return;
    try { options.onEvent(event); } catch { /* observers must never break the loop */ }
  };

  let active = 0;
  let peak = 0;
  let isStopped = false;
  const settling = new Set<Promise<void>>();

  /**
   * Which queue gets FIRST pick on the next tick. Advanced once per tick so the
   * privilege rotates; see the starvation note on `tick()`.
   */
  let firstPickCursor = 0;

  /**
   * Process one claimed job to a terminal outcome under its lease. Never
   * throws: every failure path routes through `failClaim`, and a lost lease is
   * reported without committing anything.
   */
  async function runJob(job: QueueJob<unknown>, leaseToken: string): Promise<void> {
    const handler = options.handlers[job.name];
    if (!handler) {
      // A job for an unregistered queue is a permanent, sanitized failure —
      // never a silent complete (which would drop durable work).
      await options.queue.failClaim(job.id, leaseToken, 'no_registered_handler');
      emit({ kind: 'no_handler', queueName: job.name });
      return;
    }

    // Heartbeat at a third of the lease so a slow job keeps its claim. If the
    // heartbeat reports the lease is lost, we stop extending — the handler's
    // eventual commit will fail closed on the CAS anyway.
    let leaseLost = false;
    const heartbeatMs = Math.max(1_000, Math.floor((options.leaseSeconds * 1_000) / 3));
    const beat = setInterval(() => {
      void options.queue
        .heartbeat(job.id, leaseToken, { leaseSeconds: options.leaseSeconds })
        .then((ok) => { if (!ok) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, heartbeatMs);
    // Never hold the event loop open on account of a heartbeat.
    if (typeof beat.unref === 'function') beat.unref();

    try {
      const result = await handler(job);

      // ── Deferral: a THIRD outcome, not a flavour of failure ────────────
      // The handler proved a prerequisite was not met before doing any work.
      // Returning the job to `delayed` refunds the attempt the claim charged,
      // so an outage that lasts hours costs cheap polls instead of the job's
      // whole failure budget followed by a dead letter.
      if (isDeferDirective(result)) {
        const reason = isValidDeferReason(result.reasonCode)
          ? result.reasonCode
          : FALLBACK_DEFER_REASON;
        const delay = clampDeferSeconds(result.delaySeconds ?? DEFAULT_DEFER_SECONDS);
        try {
          const outcome = await options.queue.deferClaim(job.id, leaseToken, reason, delay);
          emit({
            kind: outcome === 'deferred' ? 'deferred' : 'stale_lease',
            queueName: job.name,
            code: outcome === 'deferred' ? reason : outcome,
          });
        } catch {
          // Even the deferral path must not throw out of the runner. Nothing
          // was committed, so the lease simply expires and the reclaim sweep
          // requeues the job — no work is lost and nothing is failed.
          emit({ kind: 'poll_error', queueName: job.name, code: 'defer_error' });
        }
        return;
      }

      const committed = await options.queue.completeClaim(job.id, leaseToken);
      if (committed) {
        emit({ kind: 'completed', queueName: job.name });
      } else {
        // Stale lease: another runner already owns (or reclaimed) this job.
        // Committing nothing is the correct, fail-closed outcome.
        emit({ kind: 'stale_lease', queueName: job.name });
      }
    } catch (err) {
      // Sanitized BEFORE it can reach a durable column (see sanitizeErrorCode).
      const code = sanitizeErrorCode(err);
      try {
        const outcome = await options.queue.failClaim(job.id, leaseToken, code);
        emit({
          kind: outcome === 'not_owned' ? 'stale_lease' : 'failed',
          queueName: job.name,
          code: outcome,
        });
      } catch {
        // Even the failure path must not throw out of the runner.
        emit({ kind: 'poll_error', queueName: job.name, code: 'fail_claim_error' });
      }
    } finally {
      clearInterval(beat);
      void leaseLost; // observed for clarity; the CAS is the real guard
      active -= 1;
    }
  }

  async function tick(): Promise<number> {
    if (isStopped) return 0;
    let processed = 0;

    // ── Fair first pick (starvation fix) ──────────────────────────────────
    // Iterating `queueNames` in a FIXED order starves every queue but the
    // first whenever that first queue is permanently backlogged. `active` is
    // incremented at CLAIM and decremented only when the job SETTLES, and the
    // loop deliberately does not await settlement — so a first queue that can
    // always produce a job fills the whole concurrency budget, and by the time
    // the loop reaches the second queue `active < concurrency` is already
    // false. The later queues are then never CLAIMED from — their admission
    // gate still ran, but not one claim, and so no `claimed` event and no
    // error to alert on. Observed in production 2026-09-16, when an external
    // bulk stage-move buried `ashby.signal` under thousands of jobs and
    // `ashby.import`/`ashby.ingestion` — two jobs deep — went unclaimed
    // indefinitely behind it.
    //
    // Two mechanisms restore fairness, and BOTH are needed:
    //
    //  (a) Rotating which queue is polled FIRST. The privilege is only spent
    //      when it is actually USED — see `firstPickOffered` below. Advancing
    //      the cursor unconditionally would let a tick that claimed nothing
    //      (budget already full) or whose first-pick queue was refused by the
    //      admission gate still burn a turn, so with a handler duration near a
    //      multiple of the tick interval the same queue could win first pick
    //      every time and the starvation would survive the "fix". Parking the
    //      privilege until it is exercised makes the rotation a real bound.
    //
    //  (b) Capping what ONE queue may claim per tick when several are
    //      registered. Rotation alone is winner-take-all: the first-pick queue
    //      can still absorb the entire budget on its turn, which merely moves
    //      the starvation around the rotation — and newly lets a queue of long
    //      jobs (ingestion: download + scan + parse) block the short ones it
    //      previously sat behind. Leaving one slot for a later queue means a
    //      second queue is served on EVERY tick, not one tick in N.
    //
    // The budget itself, the admission gate and every per-queue path below are
    // untouched; only which queue is offered the budget, and how much of it
    // one queue may take in a single pass, change.
    const queueCount = queueNames.length;
    if (queueCount === 0) return 0;
    const firstPick = firstPickCursor % queueCount;
    // A single-queue runner must keep the whole budget, or this would halve
    // the throughput of every runner that has nothing to be fair to.
    const perQueueCap = queueCount === 1 ? concurrency : Math.max(1, concurrency - 1);
    let firstPickOffered = false;

    // Admission verdicts are cached for this tick: the gate is asked ONCE per
    // queue even though the queues are visited twice (reserve pass, then
    // leftover pass). `shouldClaim` can do real work — production's checks
    // malware-scanner readiness — so asking twice would double that cost.
    const admittedThisTick = new Map<string, boolean>();
    /** Queues whose claim threw this tick; the leftover pass must not retry them. */
    const erroredThisTick = new Set<string>();

    async function admits(queueName: string): Promise<boolean> {
      if (!options.shouldClaim) return true;
      const cached = admittedThisTick.get(queueName);
      if (cached !== undefined) return cached;
      let admitted: boolean;
      try {
        admitted = await options.shouldClaim(queueName);
      } catch {
        // A gate that cannot answer has not granted permission.
        admitted = false;
      }
      admittedThisTick.set(queueName, admitted);
      if (!admitted) emit({ kind: 'not_admitted', queueName });
      return admitted;
    }

    for (let offset = 0; offset < queueCount; offset += 1) {
      const queueName = queueNames[(firstPick + offset) % queueCount] as string;
      // ── Admission gate (R-2) ────────────────────────────────────────────
      // A queue whose machine-local prerequisite is unmet is skipped entirely:
      // its jobs are never claimed here, so waiting costs nothing and blocks
      // no other queue in this runner.
      const admitted = await admits(queueName);

      // Decide whether the rotation privilege was USED, before the `continue`
      // below can skip past it.
      //
      // Parked only when this queue could have used the budget and there was
      // none — that is the resonance case the privilege exists to survive.
      //
      // SPENT when the gate REFUSED it. A refused queue cannot consume a slot
      // however long it holds first pick, so parking there pins the cursor for
      // the whole refusal. `ashby.ingestion` is the only gated queue and its
      // scanner outage is budgeted at eight hours (`scannerDeferDeadlineMs`),
      // which would freeze the order at `[ingestion, signal, import]` and hand
      // every contested slot back to the storm queue — the original incident,
      // reconstructed by the fix meant to prevent it.
      if (offset === 0 && (!admitted || active < concurrency)) firstPickOffered = true;

      if (!admitted) continue;

      // Fill up to the concurrency budget, one claim at a time, but never take
      // more than this queue's share of a single tick (see `perQueueCap`). A
      // claim that returns null means the queue is empty — move on.
      let claimedHere = 0;
      while (!isStopped && active < concurrency && claimedHere < perQueueCap) {
        let job: QueueJob<unknown> | null;
        try {
          job = await options.queue.claim(queueName, {
            leaseSeconds: options.leaseSeconds,
            owner: options.owner,
          });
        } catch {
          // A DB/transport error must not kill the loop or the other queues.
          erroredThisTick.add(queueName);
          emit({ kind: 'poll_error', queueName, code: 'claim_error' });
          break;
        }
        if (!job || !job.leaseToken) break;

        active += 1;
        claimedHere += 1;
        if (active > peak) peak = active;
        processed += 1;
        emit({ kind: 'claimed', queueName });

        const p = runJob(job, job.leaseToken).finally(() => { settling.delete(p); });
        settling.add(p);
      }
    }

    // ── Leftover pass: the cap RESERVES, it must not THROTTLE ─────────────
    // The pass above deliberately leaves a slot so a sibling queue is served
    // every tick. But when the siblings are empty or gate-refused, that slot
    // would simply go unused — and because a tick claims at most its budget
    // and then returns, an unused slot is throughput permanently lost, not
    // merely deferred. On the production cadence (`signalPollMs` 5s) capping
    // the hot queue at one claim per tick would drain ~12 jobs/min, roughly
    // HALF what it manages today: the "fix" would slow the storm down.
    //
    // So once every queue has had its reserved share, any budget still free is
    // offered back in the same rotated order, uncapped. Fairness is unchanged
    // — siblings were served first — while a queue that is alone in having
    // work still gets the whole budget, exactly as before this change.
    if (!isStopped && active < concurrency && perQueueCap < concurrency) {
      // Starts at offset 1, NOT 0. The first-pick queue already took its share
      // in pass 1; offering it the leftover first would let it consume a slot
      // freed mid-tick that a sibling was reserved — including a slot freed by
      // its OWN handler settling, which is how a parked turn gets spent without
      // being spent. It also matters for the production cascade: a signal
      // handler ENQUEUES an import job, so import work routinely appears
      // between the two passes and must not lose that slot back to signal.
      for (let step = 1; step <= queueCount; step += 1) {
        if (isStopped || active >= concurrency) break;
        const queueName = queueNames[(firstPick + step) % queueCount] as string;
        // A queue whose claim already failed this tick is not retried: on a DB
        // fault every claim throws, and retrying all of them would double both
        // the load on a failing database and the `poll_error` rate an operator
        // is reading at that moment.
        if (erroredThisTick.has(queueName)) continue;
        if (!(await admits(queueName))) continue;
        while (!isStopped && active < concurrency) {
          let job: QueueJob<unknown> | null;
          try {
            job = await options.queue.claim(queueName, {
              leaseSeconds: options.leaseSeconds,
              owner: options.owner,
            });
          } catch {
            emit({ kind: 'poll_error', queueName, code: 'claim_error' });
            break;
          }
          if (!job || !job.leaseToken) break;
          active += 1;
          if (active > peak) peak = active;
          processed += 1;
          emit({ kind: 'claimed', queueName });
          const p = runJob(job, job.leaseToken).finally(() => { settling.delete(p); });
          settling.add(p);
        }
      }
    }

    // Spend the rotation only when the first-pick queue could actually have
    // used it — it was admitted and had a free slot — or when the gate refused
    // it outright (a refused queue cannot use a turn however long it holds one,
    // and parking there pinned the cursor for the whole refusal).
    //
    // KNOWN RESIDUAL, deliberately not "fixed" here: `firstPickOffered` samples
    // `active` at ONE instant, so a sibling that frees and re-takes the budget
    // later in the same tick leaves this queue parked while the tick still made
    // progress, and nothing bounds consecutive parks. Spending the turn in that
    // case was tried and rejected: it moves the cursor PAST the queue that is
    // being starved, pushing it later in the order and making the harm worse,
    // and no test could express it as a desirable property. The real exposure
    // is a long sibling job spanning tick boundaries, which no per-tick cap can
    // bound; see the PR for the follow-up.
if (firstPickOffered) firstPickCursor = (firstPick + 1) % queueCount;

    return processed;
  }

  async function stop(): Promise<void> {
    isStopped = true;
    // Await a snapshot, then re-check: a handler settling can never start new
    // work (isStopped is already true), so one extra drain pass is sufficient.
    while (settling.size > 0) {
      await Promise.allSettled([...settling]);
    }
  }

  return {
    tick,
    inFlight: () => active,
    peakInFlight: () => peak,
    stop,
    stopped: () => isStopped,
  };
}

/**
 * Geometric backoff with jitter for an idle or erroring poll loop, bounded by
 * a ceiling so neither an empty queue nor a broken DB can hot-spin.
 */
export function nextPollDelayMs(
  baseMs: number,
  consecutiveIdle: number,
  random: () => number = Math.random,
  ceilingMs = 60_000,
): number {
  const exp = Math.min(baseMs * Math.pow(2, Math.max(0, Math.min(consecutiveIdle, 10))), ceilingMs);
  // Full jitter in [0.5, 1.0) of the computed delay — de-synchronises machines.
  return Math.max(1, Math.round(exp * (0.5 + random() * 0.5)));
}
