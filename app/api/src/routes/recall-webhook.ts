/**
 * routes/recall-webhook.ts — inbound Recall.ai webhook receivers for R1 over Google Meet
 * (M034 S03, DARK by default).
 *
 *   POST /api/integrations/recall/webhook   endpoint `status`: the bot-status (Svix dashboard)
 *                                           endpoint, one per region, for every bot in the
 *                                           workspace; accepts the nine `bot.*` status events.
 *   POST /api/integrations/recall/realtime  endpoint `realtime`: the per-bot real-time endpoint the
 *                                           S01 bot builder writes into every bot
 *                                           (`R1_MEET_RECALL_REALTIME_PATH`); accepts participant
 *                                           join and leave only.
 *
 * Two paths on one router (S03 plan R1): Recall sends from two configuration points, and separate
 * paths give a strict event allowlist per source (a participant event posted to the status path is
 * ignored, and so is the reverse), clear logs, and a runbook URL that is not called "realtime" for
 * status events. Both are signed with the SAME workspace verification secret
 * (`RECALL_WEBHOOK_SECRET`, read only through `getR1MeetConfig()`), so there is no second secret.
 *
 * Mounted BEFORE the recruiter-auth middleware: it is NOT recruiter-authenticated, and it is NOT in
 * `lib/auth.ts` PUBLIC_ROUTES (critic A7: the pre-auth mount is the boundary, like the Ashby
 * receiver). Its ONLY trust boundary is the Svix / Standard Webhooks signature
 * (`integrations/recall/webhook-verify.ts`) verified over the EXACT raw request bytes BEFORE any
 * JSON parse. It is still covered by the global per-IP rate limiter.
 *
 * Flag OFF (R1 off, or Meet `disabled` / `invalid`): every request is answered 200
 * `{ ok: true, status: 'disabled' }` by a gate that runs BEFORE the raw-body parser, with no body
 * read, no verification, no DB call, no enqueue and no log line (S03 plan R2). Why 200 and not
 * 503: the critic C3 "hook deadlock". Recall disables an endpoint after about 5 days of failed
 * deliveries, so a 503 while dark would get the dashboard endpoint disabled before go-live. No
 * consumer of `r1-meet` jobs exists while the flag is off, so no job may be created either.
 * A Meet config that is set but `invalid` stays on this 200 too (contract section 9, S03 item 1),
 * unlike the Ashby schedule actions, which answer a retryable 503 `r1_meet_misconfigured` for it
 * (fix round S03-R4): the destructive signal, an HR cancellation, arrives through Ashby and is kept
 * for redelivery there, while Recall's bot telemetry in that window is the documented price. Turning
 * the flag off does NOT cancel Recall bots that are already scheduled (critic C5): drain them first
 * (runbook r1-operations.md, "Meet webhook receivers", Rollback).
 *
 * Flag ON, fail-closed order: gate -> raw body (1 MiB parser bound, answered 413 `body_too_large`
 * in this router's own shape; the verifier's own 256 KiB bound answers the same) -> Svix verify
 * (both header sets, any matching v1 entry,
 * +-300 s) -> the dedupe-space guard (a Svix id never starts `ashby-schedule:`, which 0142 keeps for
 * Ashby) -> JSON parse -> `buildR1MeetRecallEventJob` -> ONE `r1_meet_record_receipt` RPC that
 * records the de-duplicated receipt and enqueues the `recall_event` job in one transaction (critic
 * C8: at most one RPC per accepted delivery; no poller, no timer, no outbound call).
 *  - An event with no Meet meaning on that path is 200 `ignored`, with no receipt.
 *  - A signed but malformed body is a 4xx (`invalid_json`, `malformed_event`), never a 200: Svix
 *    retries any non-2xx for about a day, so a Recall schema drift stays recoverable (time to ship
 *    a fix) and triggers Recall's failure emails, while a 200 would drop the events forever (R5).
 *  - A durability failure is a retryable 500 (`receipt_persist_failed`, `receipt_rejected`,
 *    `enqueue_incomplete`, `internal_error`); 2xx only when durable work exists.
 *
 * SECURITY: the raw body, the signatures, the secret, the webhook id and every participant field
 * are never logged, persisted or returned. The job payload carries ids and times only (contract
 * §2); responses carry only a fixed status or error code.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { getR1Config } from '../lib/r1/config.js';
import {
  RECALL_WEBHOOK_DEFAULT_MAX_BYTES,
  verifyRecallWebhook,
  type RecallWebhookVerifyReason,
} from '../integrations/recall/webhook-verify.js';
import { getR1MeetConfig, r1MeetActive, type R1MeetConfig } from '../lib/r1/meet/config.js';
import { createR1MeetReceiptStore, type R1MeetReceiptPort } from '../lib/r1/meet/receipts.js';
import {
  R1_MEET_RECALL_SUBPATHS,
  buildR1MeetRecallEventJob,
  type R1MeetRecallEndpoint,
} from '../lib/r1/meet/recall-event.js';

/** The raw-body parser bound: the verifier's hard maximum (anything larger is 413 `body_too_large`). */
const RAW_BODY_LIMIT = '1mb';
/** The Ashby schedule dedupe space (0142 dedupe-space CHECK); a Svix id never has this prefix. */
const ASHBY_DEDUPE_PREFIX = 'ashby-schedule:';
/** Where the gate hands the enabled Meet config to the handler. */
const LOCALS_KEY = 'r1MeetRecallConfig';

type EnabledMeetConfig = Extract<R1MeetConfig, { enabled: true }>;

/** body-parser's error for a body over its limit (`entity.too.large`). */
function isEntityTooLarge(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: unknown }).type === 'entity.too.large';
}

/** Map a verify failure reason to a fail-closed HTTP status (S03 plan T3). */
function verifyStatus(reason: RecallWebhookVerifyReason): 400 | 401 | 403 | 413 | 503 {
  switch (reason) {
    case 'not_configured': return 503;
    case 'empty_body': return 400;
    case 'body_too_large': return 413;
    case 'missing_headers': return 401;
    case 'malformed_id': return 400;
    case 'malformed_timestamp': return 400;
    case 'malformed_signature': return 400;
    case 'timestamp_out_of_tolerance': return 401;
    case 'mismatch': return 403;
  }
}

export interface RecallWebhookRouterDeps {
  /** R1 master switch (defaults to `getR1Config()`, read per request). */
  r1Config?: () => { enabled: boolean };
  /** Meet configuration (defaults to `getR1MeetConfig()`, read per request). */
  meetConfig?: () => R1MeetConfig;
  /** The receipt port (defaults to the service-role `r1_meet_record_receipt` store, built lazily). */
  receipts?: R1MeetReceiptPort;
  /** Clock seam: epoch milliseconds (defaults to `Date.now`). */
  now?: () => number;
  /** Raw-body byte bound for verification (defaults to 256 KiB; the verifier caps it at 1 MiB). */
  maxBytes?: number;
  /** Metadata-only logger component name. */
  loggerComponent?: string;
}

/**
 * Build the Recall webhook router. In production the defaults wire the live configs and the
 * service-role receipt store; tests inject deterministic configs, a clock and an in-memory port.
 */
export function createRecallWebhookRouter(deps: RecallWebhookRouterDeps = {}): Router {
  const router = Router();
  const logger = createLogger(deps.loggerComponent ?? 'recall-webhook');
  const maxBytes = deps.maxBytes ?? RECALL_WEBHOOK_DEFAULT_MAX_BYTES;
  const now = deps.now ?? Date.now;

  // Built once, at first use, so a dark receiver never touches the store.
  let cachedReceipts: R1MeetReceiptPort | undefined = deps.receipts;
  function resolveReceipts(): R1MeetReceiptPort {
    if (!cachedReceipts) cachedReceipts = createR1MeetReceiptStore(supabase as never);
    return cachedReceipts;
  }

  /**
   * Runs BEFORE the raw-body parser. Inactive -> 200 `disabled` with nothing read, verified,
   * stored or logged. Active -> the enabled config travels to the handler in `res.locals`.
   */
  function gate(_req: Request, res: Response, next: NextFunction): void {
    const r1 = deps.r1Config ? deps.r1Config() : getR1Config();
    const meet = deps.meetConfig ? deps.meetConfig() : getR1MeetConfig();
    if (!r1MeetActive(r1, meet) || meet.enabled !== true) {
      res.status(200).json({ ok: true, status: 'disabled' });
      return;
    }
    res.locals[LOCALS_KEY] = meet;
    next();
  }

  const rawParser = express.raw({ type: '*/*', limit: RAW_BODY_LIMIT });

  /**
   * The raw-body parser, with its over-limit error answered here as 413 `body_too_large` (the
   * documented `{ ok, error }` body) instead of falling through to the app's generic 413 envelope
   * (S03-R6). Any other parser error keeps the app's handling.
   */
  function readRawBody(req: Request, res: Response, next: NextFunction): void {
    rawParser(req, res, (err?: unknown) => {
      if (err === undefined || err === null) {
        next();
        return;
      }
      if (isEntityTooLarge(err)) {
        logger.warn('unknown_event', {
          error_category: 'recall_webhook_rejected',
          error_type: 'body_too_large',
          http_status: 413,
        });
        res.status(413).json({ ok: false, error: 'body_too_large' });
        return;
      }
      next(err);
    });
  }

  function respond(res: Response, httpStatus: 200 | 400 | 500, code: string): void {
    // `code` is a closed, sanitized result: never a body, id, signature or participant field.
    logger.info('unknown_event', { error_category: 'recall_webhook_ingress', error_type: code, http_status: httpStatus });
    if (httpStatus === 200) {
      res.status(200).json({ ok: true, status: code });
      return;
    }
    res.status(httpStatus).json({ ok: false, error: code });
  }

  function handlerFor(endpoint: R1MeetRecallEndpoint) {
    return async (req: Request, res: Response): Promise<void> => {
      const meet = res.locals[LOCALS_KEY] as EnabledMeetConfig | undefined;
      if (meet === undefined) {
        // Unreachable behind the gate; fail inert rather than verify with no secret.
        res.status(200).json({ ok: true, status: 'disabled' });
        return;
      }
      const nowMs = now();
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      const verdict = verifyRecallWebhook(rawBody, req.headers, meet.recall.webhookSecret, {
        maxBytes,
        now: () => nowMs,
      });
      if (!verdict.ok) {
        const status = verifyStatus(verdict.reason);
        // Only the sanitized reason is logged: never the body, the headers or the secret.
        logger.warn('unknown_event', {
          error_category: 'recall_webhook_rejected',
          error_type: verdict.reason,
          http_status: status,
        });
        res.status(status).json({ ok: false, error: verdict.reason });
        return;
      }

      try {
        if (verdict.webhookId.startsWith(ASHBY_DEDUPE_PREFIX)) {
          respond(res, 400, 'malformed_id');
          return;
        }

        // Signature verified over the exact bytes: parse the JSON transiently.
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
          respond(res, 400, 'invalid_json');
          return;
        }

        const job = buildR1MeetRecallEventJob(parsed, endpoint);
        if (!job.ok) {
          if (job.reason === 'ignored_event') respond(res, 200, 'ignored');
          else respond(res, 400, 'malformed_event');
          return;
        }

        let answer: Awaited<ReturnType<R1MeetReceiptPort['record']>>;
        try {
          answer = await resolveReceipts().record({
            source: 'recall',
            dedupeKey: verdict.webhookId,
            eventType: job.eventType,
            bookingId: job.bookingId,
            payload: job.payload,
            nowMs,
          });
        } catch {
          respond(res, 500, 'receipt_persist_failed');
          return;
        }

        if (answer.status === 'refused') {
          // The closed refusal is safe to log; the request that caused it is not.
          logger.warn('unknown_event', {
            error_category: 'recall_webhook_receipt_refused',
            error_type: answer.reason,
            http_status: 500,
          });
          respond(res, 500, 'receipt_rejected');
          return;
        }
        if (!answer.workPending) {
          respond(res, 500, 'enqueue_incomplete');
          return;
        }
        respond(res, 200, answer.status === 'inserted' ? 'accepted' : 'duplicate');
      } catch {
        // Any unexpected internal failure is retryable: Recall (Svix) redelivers.
        respond(res, 500, 'internal_error');
      }
    };
  }

  for (const endpoint of Object.keys(R1_MEET_RECALL_SUBPATHS) as R1MeetRecallEndpoint[]) {
    router.post(
      R1_MEET_RECALL_SUBPATHS[endpoint],
      gate,
      readRawBody,
      handlerFor(endpoint),
    );
  }

  return router;
}

/** Default router instance (production wiring). */
export const recallWebhookRouter = createRecallWebhookRouter();
