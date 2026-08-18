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
import { runReconciliation, DEFAULT_CHECKPOINT_KEY } from './reconciliation.js';
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

export interface AshbyWorkers {
  scheduler: AshbySchedulerHandle;
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
        tick: async () => {
          const r = await runReconciliation({
            client: runtime.client,
            checkpoints: runtime.checkpoints,
            receipts: runtime.receipts,
            checkpointKey: DEFAULT_CHECKPOINT_KEY,
            owner,
          });
          return r.stop !== 'locked' && r.items > 0;
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
