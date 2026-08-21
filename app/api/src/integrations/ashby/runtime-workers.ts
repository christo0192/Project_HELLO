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
import {
  createQueueRunner,
  type QueueDeferDirective,
  type QueueHandler,
} from '../../lib/queue/runner.js';
import { createAshbyScheduler, queueRunnerTick, type AshbySchedulerHandle } from './scheduler.js';
import {
  processAshbySignal,
  ASHBY_SIGNAL_QUEUE,
  ASHBY_IMPORT_QUEUE,
  importDedupKey,
} from './signal-worker.js';
import { runImport, runIngestionJob } from './orchestration.js';
import { publishReconcilePass } from './runtime-health.js';
import {
  checkScannerReadiness,
  scannerDeferReason,
  type ScannerGateVerdict,
} from './scanner-readiness.js';
import { runReconciliation, DEFAULT_CHECKPOINT_KEY } from './reconciliation.js';
import type { ReconcileResult, ReconcileSkipCounts, ReconcileStop } from './reconciliation.js';
import { runAshbyOperationPass } from './operation-worker.js';
import { materializeCandidate, materializeCandidateShell } from './materialize.js';
import { extractFileUrl, type AshbyRuntime } from './runtime.js';
import { MAX_FILE_HANDLE_LEN } from './client.js';
import { isAshbyError, type AshbyErrorCategory } from './errors.js';
import type { AshbySignalPayload } from './ports.js';

/** Queue name for the ephemeral resume ingestion of one application link. */
export const ASHBY_INGESTION_QUEUE = 'ashby.ingestion';

/**
 * Ingestion states from which no further work is possible (0029 state machine).
 * A link in one of these must never re-enter fetch/scan/parse — re-downloading
 * a candidate's resume is both a PII cost and a provider cost.
 */
export const TERMINAL_INGESTION_STATES: ReadonlySet<string> = new Set(['ready', 'cancelled']);

/**
 * Default wait between scanner-readiness deferrals.
 *
 * freshclam's first successful update after a cold boot is a matter of tens of
 * seconds, so this is short enough that a ready scanner is picked up promptly
 * and long enough that an hour-long outage costs ~80 cheap DB polls rather
 * than a hot loop. Every deferral refunds its claim's attempt, so the count of
 * polls has no bearing on the job's failure budget.
 */
export const DEFAULT_SCANNER_DEFER_SECONDS = 45;

/**
 * Delay applied to a POST-SCAN deferral, by class.
 *
 * `transient` (busy / timeout / a mid-run error) clears in seconds — another
 * scan finishing, a retry of a wedged run — so a short delay is right.
 * `availability` (no database, a stale one, no scanner configured) is measured
 * in minutes at best: a cold freshclam download is minutes, so polling it
 * every minute is pure noise.
 */
export const DEFER_SECONDS_BY_CLASS = { transient: 60, availability: 300 } as const;

/**
 * Sanitized reason recorded when a deferral outlives its wall-clock deadline.
 * This is the deferral's BOUND, and it is deliberately wall-clock rather than
 * a defer counter: a counter that gates a control needs a reset lifecycle or
 * it becomes a one-way latch (the PR #65 lesson), while a deadline derived
 * from the job's own creation resets naturally with every new enqueue.
 */
export const DEFER_DEADLINE_REASON = 'scan_unavailable_deadline';

/** Fallback deadline when no tuning block is supplied (8 hours). */
export const DEFAULT_SCANNER_DEFER_DEADLINE_MS = 28_800_000;

/** Sanitized reason recorded when the bounded ingestion requeue ceiling is hit. */
export const DEFER_EXHAUSTED_REASON = 'scan_deferral_exhausted';

/**
 * Delay between PARSE deferrals.
 *
 * The two deferrable parse codes are `parse_timeout` (the child was killed on
 * a contended CPU) and `parse_overload` (the bounded pool refused). Both clear
 * on the order of one document's worth of work, so this is short — but not as
 * short as the scanner's transient class, because a parse retry re-downloads
 * the file and therefore costs a provider call each time.
 */
export const DEFAULT_PARSE_DEFER_SECONDS = 120;

/**
 * Wall-clock bound on how long one job may keep deferring on the parser.
 *
 * SHIPPED IN THE SAME CHANGE AS THE DEFERRAL, deliberately. A deferral is a
 * weakening of a terminal bound, and a weakening whose mitigation lands later
 * is a weakening that ships alone. One hour: a contended CPU or a saturated
 * pool that has not cleared in an hour is not busy, it is broken, and the
 * honest report of a broken parser is a loud failure a human can see.
 *
 * Wall clock rather than a defer counter, for the same reason the scanner's
 * bound is: a counter that gates a control needs a reset lifecycle or it
 * becomes a one-way latch. A deadline derived from the job's own creation
 * resets with every new enqueue and needs no lifecycle at all.
 */
export const DEFAULT_PARSE_DEFER_DEADLINE_MS = 3_600_000;

/** Sanitized reason recorded when a parse deferral outlives its deadline. */
export const PARSE_DEFER_DEADLINE_REASON = 'parse_defer_deadline';

/** Sanitized reason recorded when parse requeues hit the bounded ceiling. */
export const PARSE_DEFER_EXHAUSTED_REASON = 'parse_defer_exhausted';

/**
 * Sanitized reason recorded when the parse-deferral SEAM is unavailable.
 *
 * Fail-loud rather than fail-silent: a runtime that cannot record a wait must
 * not take one. Resting the row in `failed_review` with its own code keeps the
 * condition visible and recoverable through the audited admin path, instead of
 * dropping the job on the floor.
 */
export const PARSE_DEFER_UNAVAILABLE_REASON = 'parse_defer_unavailable';

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

/**
 * Ashby error categories that are DETERMINISTICALLY permanent for a queue job.
 *
 * `buildIngestionPorts` calls `client.fileInfo`, and a throw from there used to
 * propagate untouched into the queue's generic failure path, which treats any
 * thrown handler error as retryable. The canary therefore burned all five
 * ingestion attempts on `invalid_request/id_too_long` — an error whose outcome
 * was identical every single time — and dead-lettered. An `AshbyError` already
 * carries a sanitized category and a `retriable` flag; the handler just has to
 * read them.
 *
 * `retry_exhausted` is deliberately NOT here: the client already spent its own
 * bounded attempts on a transient class, and a fresh queue attempt (minutes
 * later, not milliseconds) is a genuinely different try.
 */
export const PERMANENT_ASHBY_CATEGORIES: ReadonlySet<AshbyErrorCategory> = new Set([
  'invalid_request',
  'http_client_error',
  'logical_failure',
  'malformed_response',
  'output_limit',
]);

/** True when this error can only ever fail the same way again. */
export function isPermanentAshbyFailure(err: unknown): boolean {
  if (!isAshbyError(err)) return false;
  if (err.retriable) return false;
  return PERMANENT_ASHBY_CATEGORIES.has(err.category);
}

/**
 * Delay for a post-scan deferral, chosen from the scan status' class.
 * An unclassifiable status takes the longer (availability) delay: guessing
 * "this will clear in a second" about something we do not understand is the
 * guess that hot-loops.
 */
export function deferSecondsFor(scanStatus: string): number {
  // Matched against KNOWN transient statuses rather than against the
  // classifier's verdict alone: `classifyScanStatus` deliberately falls back
  // to 'transient' for an unrecognised status (defer, never condemn), and
  // inheriting that fallback here would give an unknown condition the SHORT
  // delay — the fastest possible poll for the thing we understand least.
  const KNOWN_TRANSIENT = new Set(['scanner_busy', 'scanner_timeout', 'scanner_error']);
  return KNOWN_TRANSIENT.has(scanStatus)
    ? DEFER_SECONDS_BY_CLASS.transient
    : DEFER_SECONDS_BY_CLASS.availability;
}

/** Sanitized, bounded durable reason for a failed ingestion. Never PII. */
export function ingestionFailureReason(err: unknown): string {
  if (!isAshbyError(err)) return 'fetch_provider_error';
  return `fetch_${err.category}_${err.code}`.slice(0, 200);
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

/** Injectable seams for the handler map (tests drive these directly). */
export interface AshbyHandlerDeps {
  /**
   * Proof that the resume malware scanner can screen right now. Shares the
   * Mission Control health evidence; see `scanner-readiness.ts`.
   */
  scannerGate?: () => Promise<ScannerGateVerdict>;
  /** Delay applied to a scanner-readiness deferral (clamped by the queue). */
  scannerDeferSeconds?: number;
  /** Wall-clock bound on how long one job may keep deferring on the scanner. */
  scannerDeferDeadlineMs?: number;
  /** Delay applied to a parse deferral (clamped by the queue). */
  parseDeferSeconds?: number;
  /** Wall-clock bound on how long one job may keep deferring on the parser. */
  parseDeferDeadlineMs?: number;
  /** Injectable clock for the deadline (tests). */
  nowMs?: () => number;
}

/**
 * Build the queue handler map. Exported so tests can drive each handler in
 * isolation with an in-memory queue and fake stores.
 */
export function buildAshbyHandlers(
  runtime: AshbyRuntime,
  deps: AshbyHandlerDeps = {},
): Record<string, QueueHandler> {
  // Optional-chained throughout: `buildAshbyHandlers` is exported so tests can
  // drive one handler against a minimal runtime stub, and a handler map must
  // not require a fully-populated tuning block to be constructed.
  const rc = runtime.runtimeConfig as Partial<AshbyRuntime['runtimeConfig']> | undefined;
  const scannerGate = deps.scannerGate
    ?? (() => checkScannerReadiness({ timeoutMs: rc?.scannerReadinessTimeoutMs }));
  const scannerDeferSeconds = deps.scannerDeferSeconds
    ?? rc?.scannerDeferSeconds
    ?? DEFAULT_SCANNER_DEFER_SECONDS;
  const scannerDeferDeadlineMs = deps.scannerDeferDeadlineMs
    ?? rc?.scannerDeferDeadlineMs
    ?? DEFAULT_SCANNER_DEFER_DEADLINE_MS;
  const parseDeferSeconds = deps.parseDeferSeconds ?? DEFAULT_PARSE_DEFER_SECONDS;
  const parseDeferDeadlineMs = deps.parseDeferDeadlineMs ?? DEFAULT_PARSE_DEFER_DEADLINE_MS;
  const nowMs = deps.nowMs ?? (() => Date.now());
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
        // The shell seam. Ownership is resolved HERE, through the same
        // `resolveMappingForLink` the ready path already uses, so there is one
        // answer to "who owns rows created for this link" and not two.
        materializeShell: async (applicationLinkId) => {
          const link = await runtime.stores.readLink(applicationLinkId);
          // A terminal application gains no candidate. Not a failure.
          if (!link || link.terminalState) {
            return { status: 'skipped', reason: 'blocked_terminal' };
          }
          const mapping = await runtime.resolveMappingForLink(applicationLinkId);
          // Only an ENABLED mapping may create rows (a pause landing between
          // the import decision and this write). Nothing to own ⇒ no shell,
          // and no retry loop against a mapping that is off on purpose.
          if (!mapping) return { status: 'skipped', reason: 'no_mapping' };
          return materializeCandidateShell(applicationLinkId, {
            store: runtime.materialization,
            mapping,
            isTerminal: false,
            existingCandidateId: link.candidateId,
          });
        },
      });
      // The shell could not be bound. Throwing is the point: the durable
      // import job must NOT complete while the row that makes this application
      // visible does not exist. Every step of `runImport` is idempotent, so
      // the queue's ordinary bounded retry re-runs it safely, and a job that
      // exhausts its attempts dead-letters LOUDLY instead of leaving an
      // invisible candidate behind.
      if (result.status === 'shell_unbound') throw new Error('ashby_import_shell_unbound');
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
      // terminal state between enqueue and claim. Checked BEFORE anything
      // resolves the short-lived presigned URL — so a redundant job costs zero
      // provider calls and zero resume bytes.
      const current = await runtime.stores.readIngestion(linkId);
      if (current && TERMINAL_INGESTION_STATES.has(current.state)) return;

      // An application that carried no resume handle has nothing to ingest.
      // This is decided from the LINK — the fact itself — and never from
      // "does an ingestion row exist", because `runImport` seeds an ingestion
      // row for every link including this one.
      if (!link.externalResumeFileHandle) return;

      // ── Scanner readiness: the LAST free moment to decide not to start ──
      // Checked here, while the durable row is still `queued` and before ANY
      // provider call, because this is the only point at which "not yet" is
      // free: one transition later the row is `fetching` and the only ways
      // out of it are forward or `failed_review`.
      //
      // A negative verdict is a DEFERRAL, not a failure — the queue refunds
      // the attempt the claim charged, the ingestion row stays `queued`, and
      // nothing is downloaded, scanned, or dead-lettered. The canary's cold
      // boot burned an attempt and stranded a resume in `failed_review`
      // precisely because this question was asked after the download instead
      // of before it.
      //
      // BOUNDED RACE, stated rather than pretended away: the scanner is
      // proven ready HERE, and the bytes are scanned a bounded moment later
      // (one `file.info` call plus one download, each transport-bounded).
      // freshclam can only make the database newer and installs by atomic
      // rename, so the realistic direction of change inside that window is
      // safe. If the scanner genuinely degrades mid-flight the scan still
      // fails closed exactly as before, landing `failed_review` with a
      // transient `scan_scanner_*` reason — recoverable by the documented
      // requeue, not by silently trusting a stale verdict.
      const gate = await scannerGate();
      if (gate.action === 'defer') {
        return {
          outcome: 'defer',
          reasonCode: gate.reasonCode,
          delaySeconds: scannerDeferSeconds,
        } satisfies QueueDeferDirective;
      }

      // ── Leave `queued` BEFORE talking to the provider ──────────────────
      // The 0029 trigger allows `queued -> {fetching, cancelled}` only, so
      // `failed_review` is not reachable from `queued` at all. Every provider
      // failure below therefore used to leave the row stranded in `queued`
      // forever with no signal anywhere — the canary's durable symptom. One
      // transition first makes the existing failure path reachable, needs no
      // migration, and preserves the state machine's meaning (`fetching` =
      // "we have started talking to the provider"). The presigned URL is
      // still resolved at the last possible moment relative to the DOWNLOAD,
      // so the security rationale for late resolution is untouched.
      const started = await runtime.stores.advanceIngestion(linkId, 'fetching');
      if (started.status !== 'ok') {
        // A concurrent cancel or an illegal transition: not our work to do.
        return;
      }

      /** Record a durable, sanitized ingestion failure. Best effort. */
      const failIngestion = async (reason: string): Promise<void> => {
        try {
          await runtime.stores.advanceIngestion(linkId, 'failed_review', { failedReason: reason });
        } catch { /* the queue outcome below is the authoritative signal */ }
      };

      let built;
      try {
        built = await runtime.buildIngestionPorts({
          applicationLinkId: linkId,
          onState: async (state, provenance) => {
            // The 0029 trigger rejects an illegal transition and the RPC
            // returns `invalid_transition` rather than throwing. Ignoring that
            // status let the in-memory pipeline keep running against a durable
            // row that no longer described reality; abort instead so the bytes
            // are wiped on the ingestion's own terminal path.
            const outcome = await runtime.stores.advanceIngestion(linkId, state, provenance);
            if (outcome.status !== 'ok') {
              throw new Error(`ashby_ingestion_${outcome.status}`);
            }
          },
        });
      } catch (err) {
        if (isPermanentAshbyFailure(err)) {
          // Deterministically permanent: fail the job ONCE with the durable
          // reason recorded, instead of five identical attempts into the DLQ.
          await failIngestion(ingestionFailureReason(err));
          return;
        }
        // Transient. Retry — but on the LAST attempt record the durable
        // failure too, so a dead-lettered job can never leave the ingestion
        // row stranded mid-flight.
        if (job.attempts >= job.maxAttempts) await failIngestion(ingestionFailureReason(err));
        throw err;
      }

      if (built.status === 'link_missing') return;
      if (built.status === 'no_resume') {
        // The link claimed a handle a moment ago and now reports none. Not a
        // provider failure; nothing to ingest.
        return;
      }
      if (built.status === 'url_unresolved') {
        // A real provider failure that used to be reported as job SUCCESS.
        await failIngestion('fetch_url_unresolved');
        return;
      }
      const ports = built.ports;

      const result = await runIngestionJob(linkId, {
        gates,
        stores: runtime.stores,
        buildIngestionPorts: () => ports,
        isCancelled: async () => {
          const l = await runtime.stores.readLink(linkId);
          return l?.terminalState != null;
        },
      });

      // ── Post-scan deferral: the scanner never produced a verdict ────────
      // The file WAS downloaded (the readiness gate was satisfied when this
      // job started) but the scanner could not screen it — it went busy, timed
      // out, or lost its database mid-flight. That is not a statement about
      // the resume, so the row must not be written off. It returns to `queued`
      // (0037 retry edge) and the queue job defers with its attempt refunded.
      // ── Post-parse deferral: the PARSER never produced a verdict ────────
      // The document was fetched and screened safe; the parser child was then
      // killed by its wall-clock timeout, or the bounded pool refused the
      // submission. Neither is a statement about the document, so neither may
      // rest the row in `failed_review` — the same conflation PR #69 removed
      // from the scanner and PR #66 removed from the invite budget.
      //
      // The durable row is `extracting` here, NOT `queued`: the guard/parse
      // step transitions first so it is observable. `extracting -> queued` is
      // therefore the edge that has to exist, and migration 0039 makes it
      // legal ONLY through this guarded, reason-allowlisted, attempt-charging
      // RPC — `advance_ashby_ingestion` still refuses it.
      if (
        result.status === 'done'
        && result.outcome.state === 'deferred'
        && result.outcome.deferSource === 'parse'
      ) {
        const parseCode = result.outcome.reason;

        // BOUND, shipped with the weakening it bounds. Derived from the job's
        // own creation so it resets with every enqueue and needs no counter.
        const waitedMs = Math.max(0, nowMs() - Date.parse(job.createdAt));
        if (Number.isFinite(waitedMs) && waitedMs > parseDeferDeadlineMs) {
          await failIngestion(PARSE_DEFER_DEADLINE_REASON);
          return;
        }

        // No seam ⇒ no way to record the wait ⇒ do not take one.
        if (!runtime.stores.deferIngestionParse) {
          await failIngestion(PARSE_DEFER_UNAVAILABLE_REASON);
          return;
        }
        const requeued = await runtime.stores.deferIngestionParse(linkId, parseCode);
        if (requeued.status !== 'ok') {
          // `retry_exhausted` (the unchanged 0032 ceiling) or a concurrent
          // cancel. The row cannot go back, so rest it loudly rather than
          // defer a job whose durable state can never advance again.
          if (requeued.status === 'retry_exhausted') {
            await failIngestion(PARSE_DEFER_EXHAUSTED_REASON);
          } else {
            await failIngestion(parseCode);
          }
          return;
        }
        return {
          outcome: 'defer',
          reasonCode: parseCode,
          delaySeconds: parseDeferSeconds,
        } satisfies QueueDeferDirective;
      }

      if (result.status === 'done' && result.outcome.state === 'deferred') {
        // Normalised through the SAME minting function the readiness gate
        // uses, so both deferral classes land in one durable vocabulary and
        // the `scanner%` health filter sees all of them. Minting a reason
        // locally here is exactly how the post-scan class became invisible to
        // the counter added for it.
        const reason = scannerDeferReason(result.outcome.scanStatus);

        // BOUND. Derived from the job's own creation, so it resets with every
        // new enqueue and needs no counter with a reset lifecycle. Past it,
        // waiting stops being correct and becomes a hidden backlog, so the
        // outcome becomes a real, loud, human-visible failure.
        const waitedMs = Math.max(0, nowMs() - Date.parse(job.createdAt));
        if (Number.isFinite(waitedMs) && waitedMs > scannerDeferDeadlineMs) {
          await failIngestion(DEFER_DEADLINE_REASON);
          return;
        }

        const requeued = await runtime.stores.advanceIngestion(linkId, 'queued');
        if (requeued.status !== 'ok') {
          // `retry_exhausted` (the 0032 ceiling) or a concurrent cancel. The
          // row cannot go back, so resting it loudly beats deferring a job
          // whose durable state can never advance again.
          if (requeued.status === 'retry_exhausted') await failIngestion(DEFER_EXHAUSTED_REASON);
          return;
        }
        return {
          outcome: 'defer',
          reasonCode: reason,
          delaySeconds: deferSecondsFor(result.outcome.scanStatus),
        } satisfies QueueDeferDirective;
      }

      // Persist the candidate the instant the ephemeral parse succeeds: the
      // structured fields exist only in memory here and the original bytes have
      // already been wiped. Identity stays application-centric — the candidate
      // is bound to THIS link and never looked up by email or phone.
      if (result.status === 'done' && result.outcome.state === 'ready') {
        const mapping = await runtime.resolveMappingForLink(linkId);
        if (mapping) {
          // RE-READ the binding rather than reusing the row captured before
          // the ingestion ran. `link` was read at the top of this handler,
          // possibly minutes and one full download/scan/parse ago; the import
          // that bound the shell may have landed inside that window. A stale
          // null here would create a SECOND candidate for the same
          // application — the one outcome the CAS exists to prevent, reached
          // by never consulting it.
          // Best-effort: the row is already durably `ready` at this point, so a
          // throw here would leave the candidate unpopulated forever (a retry
          // short-circuits on the terminal state). A failed re-read therefore
          // falls back to the stale value, which is SAFE because the CAS in
          // `materializeCandidate` catches the race anyway and now populates
          // the winner rather than abandoning the parse.
          const fresh = await runtime.stores.readLink(linkId).catch(() => null);
          await materializeCandidate(linkId, result.outcome.structured, {
            store: runtime.materialization,
            mapping,
            isTerminal: false,
            existingCandidateId: fresh?.candidateId ?? link.candidateId,
          });
        }
      }
    },
  };
}

/**
 * Defensive read of the opaque resume file handle from `application.info`.
 *
 * Bounded by the SHARED {@link MAX_FILE_HANDLE_LEN} (512) rather than a local
 * literal, so this, `AshbyClient.fileInfo` and the 0029
 * `chk_ashby_application_links_resume_handle` CHECK cannot drift apart — the
 * drift between them (256 / 512 / 512) is what rejected the canary's
 * 270-character handle pre-transport. Control characters and NUL are rejected
 * here as well as in the client: a handle that reaches `createLink` must
 * already be safe, since nothing downstream re-validates it.
 */
export function extractResumeHandle(info: unknown): string | null {
  if (info === null || typeof info !== 'object') return null;
  const safe = (v: unknown): string | null => {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_FILE_HANDLE_LEN) return null;
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c <= 0x1f || c === 0x7f) return null;
    }
    return v;
  };
  const rec = info as Record<string, unknown>;
  for (const key of ['resumeFileHandle', 'fileHandle', 'resumeHandle']) {
    const v = rec[key];
    const direct = safe(v);
    if (direct) return direct;
    if (v !== null && typeof v === 'object') {
      const nested = safe((v as Record<string, unknown>).handle);
      if (nested) return nested;
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

  // ── Ingestion admission gate (R-2) ──────────────────────────────────────
  // Asked before every ingestion claim, and CHEAP by construction: a 512-byte
  // signature-header read behind a short TTL. Never the capability probe,
  // which runs the real binary behind the same gate production scans take.
  //
  // Holding the claim rather than deferring after it is what makes a cold boot
  // free: the job stays `pending`, so no attempt is spent, no lease churns, no
  // provider call is made, no resume bytes move — and a machine whose updater
  // HAS succeeded can take the job instead, which no post-claim outcome could
  // express. Only `ashby.ingestion` is gated; every other Ashby queue keeps
  // draining, because none of them touch the scanner.
  const ingestionAdmitted = async (queueName: string): Promise<boolean> => {
    if (queueName !== ASHBY_INGESTION_QUEUE) return true;
    const verdict = await checkScannerReadiness({
      timeoutMs: rc.scannerReadinessTimeoutMs,
    });
    if (verdict.action === 'proceed') return true;
    // Metadata only — a sanitized prerequisite code, never an identifier.
    logger.info('unknown_event', {
      error_category: 'ashby_ingestion_not_admitted',
      error_type: verdict.reasonCode,
    });
    return false;
  };

  const runner = createQueueRunner({
    queue: runtime.queue,
    handlers,
    owner,
    leaseSeconds: rc.leaseSeconds,
    concurrency: 2,
    pollMs: rc.signalPollMs,
    shouldClaim: ingestionAdmitted,
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
          const r = await runAshbyOperationPass({
            stores: runtime.stores,
            materialization: runtime.materialization,
            scorecard: {
              submit: (request) => runtime.client.applicationFeedbackSubmit(request),
              dashboardOrigin: (process.env.WEB_ORIGIN ?? '').split(',')[0]?.trim() ?? '',
            },
            resolveMappingForLink: runtime.resolveMappingForLink,
            reissuePathFor,
            email: { providerApproved: false, domainVerified: false },
            owner,
            leaseSeconds: rc.leaseSeconds,
          });
          return r.invite.claimed || r.scorecard.claimed;
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
