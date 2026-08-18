/**
 * ashby/runtime-workers.ts — binds the merged domain seams to the live queue,
 * the operation outbox, and the scheduler.
 *
 * This file deliberately contains NO domain logic. Every decision still comes
 * from the merged, tested modules (`processAshbySignal`, `runImport`,
 * `runIngestionJob`, `runReconciliation`, `materializeInvite`); this is only
 * the composition that lets them run. Copying a decision down into this layer
 * would fork the tested logic — don't.
 *
 * THE CHAIN, and where each hop used to break:
 *
 *   webhook → receipt+outbox        (worked already)
 *   ashby.signal  → processAshbySignal
 *                   BROKE: no consumer existed. Now claimed by the runner.
 *   import_eligible → ashby.import
 *                   BROKE: the verdict was returned to a test and discarded.
 *                   Now enqueued through `onImportEligible`, dedup-keyed by
 *                   APPLICATION so webhook redelivery + reconciliation
 *                   recovery converge to exactly one import.
 *   ashby.import  → runImport → link + invite_delivery ops + ingestion seed
 *   ashby.ingestion → runIngestionJob
 *                   BROKE: `runImport` set the ingestion row to 'queued' and
 *                   enqueued no work item for it, and there is no ingestion
 *                   member in the `operation_type` CHECK. Now a leased queue
 *                   job, dedup-keyed by link — no migration to that CHECK.
 *   invite_delivery op → materializeInvite
 *                   BROKE: `runInviteDelivery` is decision-only and nothing
 *                   created a candidate/session/invite.
 */

import { createLogger } from '../../lib/logger.js';
import { createQueueRunner, type QueueHandler } from '../../lib/queue/runner.js';
import { createAshbyScheduler, queueRunnerTick, type AshbySchedulerHandle } from './scheduler.js';
import {
  processAshbySignal,
  ASHBY_SIGNAL_QUEUE,
  ASHBY_IMPORT_QUEUE,
  importDedupKey,
} from './signal-worker.js';
import { runImport, runIngestionJob } from './orchestration.js';
import { publishReconcilePass } from './runtime-health.js';
import { runReconciliation, DEFAULT_CHECKPOINT_KEY } from './reconciliation.js';
import type { ReconcileResult, ReconcileSkipCounts, ReconcileStop } from './reconciliation.js';
import { runClaimedAshbyOperation } from './operation-worker.js';
import { materializeCandidate } from './materialize.js';
import { extractFileUrl, type AshbyRuntime } from './runtime.js';
import type { AshbySignalPayload } from './ports.js';

/** Queue name for the ephemeral resume ingestion of one application link. */
export const ASHBY_INGESTION_QUEUE = 'ashby.ingestion';

/**
 * Ingestion states from which no further work is possible (0029 state machine).
 * A link in one of these must never re-enter fetch/scan/parse — re-downloading
 * a candidate's resume is both a PII cost and a provider cost.
 */
export const TERMINAL_INGESTION_STATES: ReadonlySet<string> = new Set(['ready', 'cancelled']);

/** Deterministic dedup key for one link's ingestion. */
export function ingestionDedupKey(applicationLinkId: string): string {
  return `ashby:ingestion:${applicationLinkId}`;
}

/** Site-relative recruiter reissue path for an Ashby application. */
export function reissuePathFor(externalApplicationId: string): string {
  return `/ashby-mission-control?application=${encodeURIComponent(externalApplicationId)}`;
}

export interface AshbyWorkersOptions {
  runtime: AshbyRuntime;
  /** Opaque worker identity used as the lease owner. Never a secret. */
  owner?: string;
  /** Test seams for the scheduler's timers/jitter/clock. */
  scheduler?: Parameters<typeof createAshbyScheduler>[0] extends infer _T
    ? Partial<Pick<Parameters<typeof createAshbyScheduler>[0], 'setTimer' | 'clearTimer' | 'random' | 'now'>>
    : never;
}

/**
 * Operator-facing summary of the last completed reconciliation pass. Counters
 * and sanitized codes ONLY — no application, job, stage, candidate, or tenant
 * identifier ever appears here, so it is safe to log or surface in an admin
 * diagnostic. `observed === admitted + sum(skipped)` always holds.
 */
export interface ReconcilePassSummary {
  stop: ReconcileStop;
  mode: ReconcileResult['mode'];
  /** Applications seen on the pages read. */
  observed: number;
  /** Applications that passed admission and could create durable work. */
  admitted: number;
  /** Why the rest were declined, by reason. */
  skipped: ReconcileSkipCounts;
  /** Admitted fail-open because the row's job/stage id was unreadable. */
  unclassified: number;
  /** Enabled mappings in this pass's index; 0 ⇒ nothing can be admitted. */
  enabledMappings: number;
  /** True when more enabled mappings exist than the per-run bound (fail-loud). */
  mappingIndexTruncated: boolean;
  recovered: number;
  duplicates: number;
  enqueued: number;
  advanced: boolean;
  /**
   * Durable page-anchored continuation progress (0034). `advanced` alone
   * cannot distinguish "stuck, re-paging the same prefix forever" from
   * "eating through a >5,000 corpus one bounded run at a time" — this can.
   */
  partialProgress: ReconcileResult['partialProgress'];
}

export interface AshbyWorkers {
  scheduler: AshbySchedulerHandle;
  /**
   * Last completed reconciliation pass, or null before the first one. The
   * truthful observed/admitted/skipped triple for operators; in-process only.
   */
  lastReconcilePass(): ReconcilePassSummary | null;
  /**
   * Per-loop base interval (ms), keyed by loop name. The health surface needs
   * these to decide whether a loop's last tick is stale for ITS own cadence.
   */
  loopIntervalsMs: Record<string, number>;
  /** Drive one pass of every loop directly (tests; no timers involved). */
  tickAll(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the queue handler map. Exported so tests can drive each handler in
 * isolation with an in-memory queue and fake stores.
 */
export function buildAshbyHandlers(runtime: AshbyRuntime): Record<string, QueueHandler> {
  const gates = {
    enabled: true,
    // The email channel stays provider-gated until an approved provider AND a
    // verified sending domain exist. Both false here means zero sends.
    email: { providerApproved: false, domainVerified: false },
  };

  return {
    // ── 1. Signal: re-read authoritative state, gate, and schedule an import ──
    [ASHBY_SIGNAL_QUEUE]: async (job) => {
      const payload = job.payload as AshbySignalPayload;
      await processAshbySignal(payload, {
        client: runtime.client,
        mappings: runtime.mappings,
        receipts: runtime.receipts,
        // candidateDelete stays capability-gated OFF until a tenant probe.
        candidateDeleteEnabled: false,
        onImportEligible: async ({ applicationId }) => {
          // Dedup by APPLICATION: a duplicate webhook, a redelivery, and a
          // reconciliation recovery all collapse onto one live import job.
          await runtime.queue.enqueue(
            ASHBY_IMPORT_QUEUE,
            { provider: 'ashby', externalApplicationId: applicationId },
            { dedupKey: importDedupKey(applicationId), maxAttempts: 5 },
          );
        },
      });
    },

    // ── 2. Import: link + invite operations + ingestion work item ────────────
    [ASHBY_IMPORT_QUEUE]: async (job) => {
      const payload = job.payload as { externalApplicationId?: string };
      const appId = payload?.externalApplicationId;
      if (typeof appId !== 'string' || appId.length === 0) {
        throw new Error('malformed_import_payload');
      }
      const result = await runImport(appId, {
        gates,
        client: runtime.client,
        stores: runtime.stores,
        resolveMapping: (jobId) => runtime.resolveMappingByJobId(jobId),
        readResumeFileHandle: (info) => extractResumeHandle(info),
      });
      if (result.status !== 'imported') return;

      // Seed the ephemeral ingestion as durable work — but ONLY when there is
      // ingestion work left to do. `ready` and `cancelled` are terminal states
      // in the 0029 state machine, so a redelivered signal against an
      // already-ingested link must not re-enqueue: doing so re-resolved a
      // presigned URL and re-downloaded, re-scanned and re-parsed the
      // candidate's resume while the durable row still read `ready`
      // (review finding M2).
      const existingIngestion = await runtime.stores.readIngestion(result.applicationLinkId);
      if (existingIngestion && TERMINAL_INGESTION_STATES.has(existingIngestion.state)) return;

      await runtime.queue.enqueue(
        ASHBY_INGESTION_QUEUE,
        { provider: 'ashby', applicationLinkId: result.applicationLinkId },
        { dedupKey: ingestionDedupKey(result.applicationLinkId), maxAttempts: 5 },
      );
    },

    // ── 3. Ingestion: ephemeral fetch → scan → parse → candidate ─────────────
    // `buildIngestionPorts` is async (it resolves a short-lived presigned URL),
    // but `runIngestionJob` takes a sync factory — so the ports are awaited
    // here and handed over as a thunk.
    [ASHBY_INGESTION_QUEUE]: async (job) => {
      const payload = job.payload as { applicationLinkId?: string };
      const linkId = payload?.applicationLinkId;
      if (typeof linkId !== 'string' || linkId.length === 0) {
        throw new Error('malformed_ingestion_payload');
      }

      const link = await runtime.stores.readLink(linkId);
      // A terminal application is not an error — there is simply no work.
      if (!link || link.terminalState) return;

      // Second guard, at execution time: the ingestion may have reached a
      // terminal state between enqueue and claim. Checked BEFORE
      // `buildIngestionPorts`, which is what resolves the short-lived
      // presigned URL — so a redundant job costs zero provider calls and
      // zero resume bytes.
      const current = await runtime.stores.readIngestion(linkId);
      if (current && TERMINAL_INGESTION_STATES.has(current.state)) return;

      const ports = await runtime.buildIngestionPorts({
        applicationLinkId: linkId,
        onState: async (state, provenance) => {
          // The 0029 trigger rejects an illegal transition and the RPC returns
          // `invalid_transition` rather than throwing. Ignoring that status
          // let the in-memory pipeline keep running against a durable row that
          // no longer described reality; abort instead so the bytes are wiped
          // on the ingestion's own terminal path.
          const outcome = await runtime.stores.advanceIngestion(linkId, state, provenance);
          if (outcome.status !== 'ok') {
            throw new Error(`ashby_ingestion_${outcome.status}`);
          }
        },
      });
      // No resume handle / no resolvable presigned URL → nothing to ingest.
      if (!ports) return;

      const result = await runIngestionJob(linkId, {
        gates,
        stores: runtime.stores,
        buildIngestionPorts: () => ports,
        isCancelled: async () => {
          const l = await runtime.stores.readLink(linkId);
          return l?.terminalState != null;
        },
      });

      // Persist the candidate the instant the ephemeral parse succeeds: the
      // structured fields exist only in memory here and the original bytes have
      // already been wiped. Identity stays application-centric — the candidate
      // is bound to THIS link and never looked up by email or phone.
      if (result.status === 'done' && result.outcome.state === 'ready') {
        const mapping = await runtime.resolveMappingForLink(linkId);
        if (mapping) {
          await materializeCandidate(linkId, result.outcome.structured, {
            store: runtime.materialization,
            mapping,
            isTerminal: false,
            existingCandidateId: link.candidateId,
          });
        }
      }
    },
  };
}

/** Defensive read of the opaque resume file handle from `application.info`. */
export function extractResumeHandle(info: unknown): string | null {
  if (info === null || typeof info !== 'object') return null;
  const rec = info as Record<string, unknown>;
  for (const key of ['resumeFileHandle', 'fileHandle', 'resumeHandle']) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= 512) return v;
    if (v !== null && typeof v === 'object') {
      const h = (v as Record<string, unknown>).handle;
      if (typeof h === 'string' && h.length > 0 && h.length <= 512) return h;
    }
  }
  const resume = rec.resume;
  if (resume !== null && typeof resume === 'object') return extractResumeHandle(resume);
  return null;
}

export { extractFileUrl };

/**
 * Wire the runtime into a scheduler. Nothing is armed until `scheduler.start()`.
 */
export function createAshbyWorkers(options: AshbyWorkersOptions): AshbyWorkers {
  const runtime = options.runtime;
  const owner = options.owner ?? `api-${process.pid}`;
  const logger = createLogger('ashby-runtime');
  const rc = runtime.runtimeConfig;

  // The ingestion handler needs the async ports factory, which `runIngestionJob`
  // cannot await for us — so build the ports first and pass a sync thunk.
  const handlers = buildAshbyHandlers(runtime);

  /**
   * Last completed (non-`locked`) reconciliation pass. In-process and
   * best-effort: it is an operator/diagnostic surface for the truthful
   * observed → admitted → skipped triple, never a durability mechanism.
   */
  let lastReconcilePass: ReconcilePassSummary | null = null;

  const runner = createQueueRunner({
    queue: runtime.queue,
    handlers,
    owner,
    leaseSeconds: rc.leaseSeconds,
    concurrency: 2,
    pollMs: rc.signalPollMs,
    onEvent: (e) => {
      // Metadata only: queue name + sanitized code. Never a payload or token.
      logger.info('unknown_event', { error_category: `queue_${e.kind}`, error_type: e.queueName });
    },
  });

  const scheduler = createAshbyScheduler({
    ...(options.scheduler ?? {}),
    loops: [
      {
        name: 'signal',
        intervalMs: rc.signalPollMs,
        tick: queueRunnerTick(runner),
      },
      {
        name: 'operation',
        intervalMs: rc.operationPollMs,
        tick: async () => {
          const r = await runClaimedAshbyOperation({
            stores: runtime.stores,
            materialization: runtime.materialization,
            resolveMappingForLink: runtime.resolveMappingForLink,
            reissuePathFor,
            email: { providerApproved: false, domainVerified: false },
            owner,
            leaseSeconds: rc.leaseSeconds,
          });
          return r.claimed;
        },
      },
      {
        name: 'reconcile',
        intervalMs: rc.reconcileIntervalMs,
        // While a page-anchored sweep is in flight, tick on the SHORT sweep
        // cadence instead. Production measured ~119,000 applications paging
        // ~100 at a time: at the 15-minute rest cadence that backfill would
        // take a day, and the anchor would be 15 minutes stale on every
        // resume. The single-flight lease makes the short interval safe — an
        // overlapping tick returns `locked` before any provider call.
        // Halted streams fall back to the REST cadence: there is nothing to
        // sweep, and polling a halted stream every few seconds is pure waste.
        intervalMsFor: () =>
          (lastReconcilePass?.partialProgress.continuationPending
            && !lastReconcilePass.partialProgress.halted
            ? rc.reconcileSweepIntervalMs
            : rc.reconcileIntervalMs),
        tick: async () => {
          const r = await runReconciliation({
            client: runtime.client,
            checkpoints: runtime.checkpoints,
            receipts: runtime.receipts,
            // Admission source. Without it reconciliation would record and
            // enqueue EVERY application it observed — the tenant-wide signal
            // storm this loop exists to avoid.
            mappings: runtime.enabledMappings,
            checkpointKey: DEFAULT_CHECKPOINT_KEY,
            owner,
            // Tunable without a deploy: a backfill against a large corpus
            // needs different bounds than steady-state reconciliation.
            caps: {
              ...rc.reconcileCaps,
              anchorDisabled: rc.reconcileAnchorDisabled,
            },
          });
          if (r.stop !== 'locked') {
            // Numeric admission counters go to the metrics sink (emitted
            // inside `runReconciliation`); this snapshot is the operator-facing
            // read of the last pass. The repo LOGGER enforces a strict metadata
            // allowlist mirrored in the Python voice service, so the log line
            // below carries only allowlisted fields.
            lastReconcilePass = {
              stop: r.stop,
              mode: r.mode,
              observed: r.observed,
              admitted: r.admitted,
              skipped: r.skipped,
              unclassified: r.unclassified,
              enabledMappings: r.mappingsLoaded,
              mappingIndexTruncated: r.mappingIndexTruncated,
              recovered: r.recovered,
              duplicates: r.duplicates,
              enqueued: r.enqueued,
              advanced: r.advanced,
              partialProgress: r.partialProgress,
            };
            // Publish to the health registry so the counts have a REAL consumer
            // (Mission Control /health). Without this the re-activation gate
            // "admitted = 0 and enqueued = 0 while every mapping is paused" is
            // not executable: the metrics sink is a no-op in this deployment,
            // so the numbers would never leave the worker process.
            publishReconcilePass(lastReconcilePass);
            logger.info('unknown_event', {
              error_category: 'ashby_reconcile_pass',
              error_type: r.stop,
            });
            // A truncated index means enabled mappings exist that this pass
            // could not admit against — fail-loud, since the symptom (missing
            // imports) is otherwise silent.
            if (r.mappingIndexTruncated) {
              logger.warn('unknown_event', {
                error_category: 'ashby_reconcile_mapping_index_truncated',
                error_type: 'bound_exceeded',
              });
            }
            // The circuit breaker and the schema-drift abort are the two stops
            // an operator must never have to discover from a queue graph.
            if (r.stop === 'enqueue_cap' || r.stop === 'unclassified_cap') {
              logger.warn('unknown_event', {
                error_category: 'ashby_reconcile_aborted',
                error_type: r.stop,
              });
            }
            // A refused page anchor means this run lost the continuation to a
            // newer generation or to another lease holder. It is not an error
            // (the sweep restarts safely) but it must not be silent, because a
            // stream that hits it every pass never finishes a full resync.
            if (r.stop === 'continuation_conflict') {
              logger.warn('unknown_event', {
                error_category: 'ashby_reconcile_continuation_conflict',
                error_type: r.stop,
              });
            }
            // An abandoned sweep is the loudest signal here: the corpus could
            // not be swept within its budget, or the resumed cursor was not
            // usable. Reconciliation is not covering this tenant until it is
            // understood.
            if (r.stop === 'sweep_budget' || r.stop === 'cursor_invalid') {
              logger.error('unknown_event', {
                error_category: 'ashby_reconcile_sweep_abandoned',
                error_type: r.stop,
              });
            }
            // HALTED is the loudest state this subsystem has: reconciliation
            // has stopped itself on this stream and will make no provider call
            // until an operator forces a resync. It is what keeps the
            // page-aligned breaker from becoming an unbounded rate.
            if (r.stop === 'halted') {
              logger.error('unknown_event', {
                error_category: 'ashby_reconcile_halted',
                error_type: r.stop,
              });
            }
          }
          // "Did work" means work was ADMITTED — a pass that observed thousands
          // of applications and admitted none is idle, not busy, and must not
          // make the scheduler poll faster.
          return r.stop !== 'locked' && r.admitted > 0;
        },
      },
      {
        name: 'reclaim',
        intervalMs: rc.reclaimIntervalMs,
        tick: async () => {
          // Nothing called reclaimExpired in production, so a machine stopped
          // mid-job (Fly `auto_stop_machines`) left its lease to expire with no
          // sweeper to requeue or dead-letter the job.
          const r = await runtime.queue.reclaimExpired({ limit: 50 });
          return r.requeued.length + r.deadLettered.length > 0;
        },
      },
    ],
  });

  return {
    scheduler,
    lastReconcilePass: () => lastReconcilePass,
    loopIntervalsMs: {
      signal: rc.signalPollMs,
      operation: rc.operationPollMs,
      reconcile: rc.reconcileIntervalMs,
      reclaim: rc.reclaimIntervalMs,
    },
    async tickAll() {
      await runner.tick();
    },
    async stop() {
      await scheduler.stop();
      await runner.stop();
      await runtime.shutdown();
    },
  };
}
