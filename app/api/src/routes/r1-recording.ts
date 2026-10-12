/**
 * Worker-facing R1 recording routes (IMPLEMENTER-RULES C4), mounted at
 * `/api/internal/r1/recording` before recruiter auth, behind the worker bearer secret:
 *
 *   POST prepare     { room, mode }
 *   POST part-url    { room, part_number }
 *   POST object-url  { room, kind }
 *   POST complete    { room, layout, has_video, failure_reason?, degraded_reason?, report? }
 *
 * Rules that hold for every route:
 *  - Success is HTTP 200 with JSON, never 201/202 (the worker's helper accepts only 200 here).
 *  - Every response, errors included, is `Cache-Control: no-store`; errors are `{ "error": "<code>" }`.
 *  - The gate (`lib/r1/recording/gate.ts`) runs first and re-checks the config, the live R1 session,
 *    the operational switch and the candidate's live consent on EVERY call.
 *  - No response ever contains the multipart upload id, an object key, the bucket or an ETag. A
 *    presigned URL appears only in the `part-url` / `object-url` answer to the worker.
 *  - Nothing is logged but a fixed category code; `prepare` and `complete` are audited
 *    (`recording.upload`, FAIL-CLOSED: an audit outage makes the route answer 503, which the worker
 *    treats as retry and then as recording off; the interview is never affected).
 *
 * The router is built by {@link createR1RecordingInternalRouter} so tests can inject every
 * collaborator; the exported `r1RecordingInternalRouter` is the production instance. The staff
 * playback and health routes join this file in a later task.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { workerAuth } from './r1.js';
import { supabase } from '../lib/supabase.js';
import { getR1Config } from '../lib/r1/config.js';
import { recordAudit } from '../lib/audit.js';
import { createLogger } from '../lib/logger.js';
import { Queue } from '../lib/queue/index.js';
import { PgAdapter } from '../lib/queue/pg-adapter.js';
import {
  CHECKPOINT_INTERVAL_SEC,
  MAX_PARTS,
  PART_SIZE,
  WORKER_URL_TTL_SEC,
  getR1RecordingConfig,
  type R1RecordingConfig,
} from '../lib/r1/recording/config.js';
import {
  createSessionLimiter,
  runRecordingGate,
  type R1RecordingGateContext,
  type R1RecordingGateDeps,
  type SessionLimiter,
} from '../lib/r1/recording/gate.js';
import { isObjectKind, isRecordingMode, mp4ContentType } from '../lib/r1/recording/keys.js';
import { degradedReason, sanitizeCompleteReport, workerFailureReason, type R1RecordingLayout } from '../lib/r1/recording/service.js';
import { getR1RecordingStore } from '../lib/r1/recording/store-factory.js';
import { isR1StoreError, type R1ObjectStore } from '../lib/r1/recording/store.js';
import {
  completeOp,
  objectUrlOp,
  partUrlOp,
  prepareOp,
  type OpResult,
  type R1WorkerOpDeps,
} from '../lib/r1/recording/worker-ops.js';
import type { R1DbClient } from '../services/r1-assessment.js';

const logger = createLogger('r1-recording');

export interface R1RecordingRouteDeps {
  readonly db?: R1DbClient;
  /** The object store for an ENABLED config. Production: the shared S3 store. */
  readonly store?: (config: Extract<R1RecordingConfig, { enabled: true }>) => R1ObjectStore;
  readonly r1Enabled?: () => boolean;
  readonly recordingConfig?: () => R1RecordingConfig;
  readonly enqueue?: R1RecordingGateDeps['enqueue'];
  readonly now?: () => Date;
  readonly limiter?: SessionLimiter;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Worker authentication; production is the shared `workerAuth` of `routes/r1.ts`. */
  readonly auth?: RequestHandler;
  /** Audit sink for `recording.upload`; production is `recordAudit` (fail-closed event). */
  readonly audit?: (req: Request, metadata: Record<string, unknown>) => Promise<void>;
}

const LAYOUTS: readonly string[] = ['combined', 'split', 'audio_only'];

let defaultQueue: Queue | null = null;
const defaultEnqueue: R1RecordingGateDeps['enqueue'] = (name, payload, options) => {
  defaultQueue ??= new Queue(new PgAdapter(supabase as unknown as SupabaseClient), { defaultMaxAttempts: 5 });
  return defaultQueue.enqueue(name, payload, options);
};

/** A category code for the log: a store error carries its closed code, anything else its class name. */
function categoryOf(error: unknown): string {
  if (isR1StoreError(error)) return `r1_recording_store_${error.code}`;
  const name = error instanceof Error ? error.name : 'unknown';
  return /^[A-Za-z0-9_]{1,40}$/.test(name) ? `r1_recording_${name}` : 'r1_recording_error';
}

export function createR1RecordingInternalRouter(deps: R1RecordingRouteDeps = {}): Router {
  const router = Router();
  const db = deps.db ?? (supabase as unknown as R1DbClient);
  const now = deps.now ?? ((): Date => new Date());
  const limiter = deps.limiter ?? createSessionLimiter();
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const recordingConfig = deps.recordingConfig ?? ((): R1RecordingConfig => getR1RecordingConfig());
  const storeFor = deps.store ?? getR1RecordingStore;
  const auditUpload = deps.audit
    ?? (async (req: Request, metadata: Record<string, unknown>): Promise<void> => {
      await recordAudit(req, 'recording.upload', 200, { metadata });
    });

  const gateDeps: R1RecordingGateDeps = {
    db,
    r1Enabled: deps.r1Enabled ?? ((): boolean => getR1Config().enabled),
    recordingConfig,
    enqueue: deps.enqueue ?? defaultEnqueue,
    now,
    limiter,
    log: (category) => logger.warn('unknown_event', { error_category: category }),
  };

  // Every answer, errors included, is uncacheable.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const send = (res: Response, status: number, body: unknown): void => {
    res.status(status).json(body);
  };
  const reject = (res: Response, result: Extract<OpResult<unknown>, { ok: false }>): void => {
    send(res, result.status, { error: result.error });
  };
  const bad = (res: Response): void => send(res, 400, { error: 'invalid_recording_request' });

  /** Run the gate, then the handler; any unexpected failure is a retryable 503 with a sanitized log line. */
  function guarded(
    handler: (req: Request, res: Response, ctx: R1RecordingGateContext, ops: R1WorkerOpDeps) => Promise<void>,
  ): RequestHandler {
    return async (req, res) => {
      try {
        const gate = await runRecordingGate(gateDeps, req.body);
        if (!gate.ok) {
          send(res, gate.status, { error: gate.error });
          return;
        }
        const ops: R1WorkerOpDeps = { db, store: storeFor(gate.ctx.config), now, sleep };
        await handler(req, res, gate.ctx, ops);
      } catch (error) {
        logger.warn('unknown_event', { error_category: categoryOf(error) });
        if (!res.headersSent) send(res, 503, { error: 'service_unavailable' });
      }
    };
  }

  const auth = deps.auth ?? workerAuth;

  router.post('/prepare', auth, guarded(async (req, res, ctx, ops) => {
    const mode = (req.body as { mode?: unknown } | undefined)?.mode;
    if (!isRecordingMode(mode)) return bad(res);
    const result = await prepareOp(ops, ctx, mode);
    if (!result.ok) return reject(res, result);
    const row = result.value;
    await auditUpload(req, { resource: 'r1_recording', op: 'prepare', session_id: ctx.sessionId, round_id: ctx.roundId, mode: row.requested_mode });
    send(res, 200, {
      mode: row.requested_mode,
      content_type: mp4ContentType(row.requested_mode),
      part_size: PART_SIZE,
      max_parts: MAX_PARTS,
      next_part: row.parts_issued + 1,
      checkpoint_interval_sec: CHECKPOINT_INTERVAL_SEC,
      url_ttl_sec: WORKER_URL_TTL_SEC,
    });
  }));

  router.post('/part-url', auth, guarded(async (req, res, ctx, ops) => {
    const partNumber = (req.body as { part_number?: unknown } | undefined)?.part_number;
    if (typeof partNumber !== 'number' || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) return bad(res);
    const result = await partUrlOp(ops, ctx, partNumber);
    if (!result.ok) return reject(res, result);
    send(res, 200, { url: result.value.url, part_number: result.value.part_number, expires_in_sec: WORKER_URL_TTL_SEC });
  }));

  router.post('/object-url', auth, guarded(async (req, res, ctx, ops) => {
    const kind = (req.body as { kind?: unknown } | undefined)?.kind;
    if (!isObjectKind(kind)) return bad(res);
    const result = await objectUrlOp(ops, ctx, kind);
    if (!result.ok) return reject(res, result);
    send(res, 200, { url: result.value.url, kind: result.value.kind, content_type: result.value.content_type, expires_in_sec: WORKER_URL_TTL_SEC });
  }));

  router.post('/complete', auth, guarded(async (req, res, ctx, ops) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.layout !== 'string' || !LAYOUTS.includes(body.layout) || typeof body.has_video !== 'boolean') return bad(res);
    const result = await completeOp(ops, ctx, {
      layout: body.layout as R1RecordingLayout,
      has_video: body.has_video,
      // Codes outside the worker's vocabulary are stored as NULL, never rejected (C4).
      failure_reason: workerFailureReason(body.failure_reason),
      degraded_reason: degradedReason(body.degraded_reason),
      report: sanitizeCompleteReport(body.report),
    });
    if (!result.ok) return reject(res, result);
    await auditUpload(req, { resource: 'r1_recording', op: 'complete', session_id: ctx.sessionId, round_id: ctx.roundId, layout: body.layout, has_video: body.has_video });
    send(res, 200, { status: result.value.status });
  }));

  return router;
}

export const r1RecordingInternalRouter: Router = createR1RecordingInternalRouter();
