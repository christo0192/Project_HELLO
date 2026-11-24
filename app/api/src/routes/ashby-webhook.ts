/**
 * routes/ashby-webhook.ts — inbound Ashby webhook receiver.
 *
 * POST /api/integrations/ashby/webhook
 *
 * Mounted BEFORE the recruiter-auth middleware (like the internal worker-assess
 * router): it is NOT recruiter-authenticated. Its ONLY trust boundary is the
 * HMAC-SHA256 `Ashby-Signature` verified over the EXACT raw request bytes,
 * BEFORE any JSON parsing. It is still covered by the global per-IP rate limiter.
 *
 * Fail-closed order: integration active? → raw-body bound → signature verify →
 * JSON parse → durable dedup-safe receipt → (maybe) enqueue one signal → 2xx.
 * Internal durability/enqueue failure returns a retryable 5xx so Ashby retries;
 * a signed-but-unusable body returns a non-retryable 4xx so Ashby does not storm.
 *
 * SECURITY: the raw body, signature, and secret are never logged, persisted, or
 * returned. Responses carry only a stable sanitized status code. When the
 * integration is disabled (default) the route makes no DB or network call.
 *
 * R1 over Google Meet (M034 S03, dark): after the JSON parse, and ONLY for
 * `interviewScheduleCreate` / `interviewScheduleUpdate`, the route reads the Meet
 * configuration. When R1_MEET_ENABLED and R1_ENABLED are both on, the delivery
 * goes to `ingestR1MeetAshbySchedule` (lib/r1/meet/ashby-schedule-jobs.ts), which
 * records one `r1_meet_record_receipt` receipt and `ashby_schedule` job per Dex
 * interview event (the S03 plan R9 forwarding table: a Dex-less Update is still
 * forwarded once so S06 can cancel, a Dex-less Create is not) and answers with
 * the same `{ ok, status | error }` bodies (category `ashby_webhook_r1_meet`).
 * Otherwise nothing changes: every other action never reads the Meet config, and
 * with the flag off (Meet `disabled`, or R1 off) the schedule actions fall through
 * to the unchanged generic ingress below (today: 400 `unresolvable_id`, no DB
 * call). A Meet configuration that is SET but `invalid` (for example a malformed
 * RECALL_WEBHOOK_SECRET, or R1_MEET_ENABLED=yes) is not "off": the two schedule
 * actions answer a retryable 503 `r1_meet_misconfigured` with no DB call, so Ashby
 * redelivers once the value is fixed instead of losing an HR cancellation to a
 * non-retried 400 (fix round S03-R4; Ashby webhooks are per action type, so only
 * the schedule webhooks see it). Ids, times and the canonical Meet URL only: no
 * name or email is stored or queued, and only the scheduler's Ashby user id
 * travels. No queue handler is registered here (S06).
 */

import express, { Router, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import {
  loadAshbyConfig,
  isAshbyWebhookActive,
  type AshbyIntegrationConfig,
} from '../integrations/ashby/config.js';
import {
  verifyAshbySignature,
  DEFAULT_WEBHOOK_MAX_BYTES,
  type WebhookVerifyReason,
} from '../integrations/ashby/webhook-verify.js';
import { ingestWebhook } from '../integrations/ashby/ingress.js';
import { createReceiptStore } from '../integrations/ashby/stores.js';
import type { ReceiptStore } from '../integrations/ashby/ports.js';
import { getR1Config } from '../lib/r1/config.js';
import { getR1MeetConfig, r1MeetActive, type R1MeetConfig } from '../lib/r1/meet/config.js';
import { isR1MeetAshbyScheduleAction } from '../lib/r1/meet/ashby-schedule.js';
import { ingestR1MeetAshbySchedule } from '../lib/r1/meet/ashby-schedule-jobs.js';
import { createR1MeetReceiptStore, type R1MeetReceiptPort } from '../lib/r1/meet/receipts.js';

/** Canonical Ashby signature header (case-insensitive on read). */
const SIGNATURE_HEADER = 'ashby-signature';

/** Map a verify failure reason to a fail-closed HTTP status. */
function verifyStatus(reason: WebhookVerifyReason): 400 | 401 | 403 | 413 | 503 {
  switch (reason) {
    case 'not_configured': return 503;
    case 'missing_signature': return 401;
    case 'malformed_signature': return 400;
    case 'empty_body': return 400;
    case 'body_too_large': return 413;
    case 'mismatch': return 403;
  }
}

export interface AshbyWebhookRouterDeps {
  /** Integration config (defaults to loadAshbyConfig()). */
  config?: AshbyIntegrationConfig;
  /**
   * Transactional-outbox receipt store (defaults to the service-role Supabase
   * store). Its `record` writes the receipt AND the signal job in one tx.
   */
  receipts?: ReceiptStore;
  /** Raw-body byte bound for signature verification. */
  maxBytes?: number;
  /** Metadata-only logger component name. */
  loggerComponent?: string;
  /** R1 over Google Meet seams (M034 S03); each defaults to the production wiring. */
  r1Meet?: {
    /** R1 master switch (defaults to `getR1Config()`, read per schedule delivery). */
    r1Config?: () => { enabled: boolean };
    /** Meet configuration (defaults to `getR1MeetConfig()`, read per schedule delivery). */
    meetConfig?: () => R1MeetConfig;
    /** Meet receipt port (defaults to the service-role `r1_meet_record_receipt` store, built lazily). */
    receipts?: R1MeetReceiptPort;
    /** Clock seam: epoch milliseconds (defaults to `Date.now`). */
    now?: () => number;
  };
}

type EnabledMeetConfig = Extract<R1MeetConfig, { enabled: true }>;

/** How a schedule action is routed: the Meet branch, the retryable misconfiguration answer, or legacy. */
type MeetRoute =
  | { readonly kind: 'active'; readonly meet: EnabledMeetConfig }
  | { readonly kind: 'misconfigured' }
  | { readonly kind: 'off' };

const MEET_OFF: MeetRoute = Object.freeze({ kind: 'off' as const });
const MEET_MISCONFIGURED: MeetRoute = Object.freeze({ kind: 'misconfigured' as const });

/**
 * Build the Ashby webhook router. In production, defaults wire the service-role
 * Supabase receipt store + leased queue; tests inject deterministic fakes.
 */
export function createAshbyWebhookRouter(deps: AshbyWebhookRouterDeps = {}): Router {
  const router = Router();
  const logger = createLogger(deps.loggerComponent ?? 'ashby-webhook');
  const maxBytes = deps.maxBytes ?? DEFAULT_WEBHOOK_MAX_BYTES;

  // Lazily-resolved config/deps so a disabled integration does no work and unit
  // tests can inject everything. Defaults are built once at first use.
  let cachedReceipts: ReceiptStore | undefined = deps.receipts;

  function resolveConfig(): AshbyIntegrationConfig {
    return deps.config ?? loadAshbyConfig();
  }
  function resolveReceipts(): ReceiptStore {
    if (!cachedReceipts) cachedReceipts = createReceiptStore(supabase as never);
    return cachedReceipts;
  }

  // R1 over Google Meet: read only for the two schedule actions; the store is built at first use.
  const meetDeps = deps.r1Meet ?? {};
  const meetNow = meetDeps.now ?? Date.now;
  let cachedMeetReceipts: R1MeetReceiptPort | undefined = meetDeps.receipts;
  function resolveMeetReceipts(): R1MeetReceiptPort {
    if (!cachedMeetReceipts) cachedMeetReceipts = createR1MeetReceiptStore(supabase as never);
    return cachedMeetReceipts;
  }
  /**
   * `active` when R1 and Meet are both on; `misconfigured` when the Meet configuration is set but
   * `invalid` (whatever R1 says); else `off` (the unchanged generic path).
   */
  function meetRoute(): MeetRoute {
    try {
      const meet = meetDeps.meetConfig ? meetDeps.meetConfig() : getR1MeetConfig();
      if (meet.status === 'invalid') return MEET_MISCONFIGURED;
      if (meet.enabled !== true) return MEET_OFF;
      const r1 = meetDeps.r1Config ? meetDeps.r1Config() : getR1Config();
      return r1MeetActive(r1, meet) ? { kind: 'active', meet } : MEET_OFF;
    } catch {
      // Fail inert: an unreadable configuration means the flag is off.
      return MEET_OFF;
    }
  }

  router.post(
    '/webhook',
    express.raw({ type: '*/*', limit: '2mb' }),
    async (req: Request, res: Response) => {
      const config = resolveConfig();

      // Fail closed when the integration is disabled or the secret is absent:
      // no verification, no receipt, no queue — and no network call.
      if (!isAshbyWebhookActive(config)) {
        return res.status(503).json({ ok: false, error: 'integration_disabled' });
      }

      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const signature = req.header(SIGNATURE_HEADER) ?? undefined;

      const verdict = verifyAshbySignature(rawBody, signature, config.webhookSecret, { maxBytes });
      if (!verdict.ok) {
        const status = verifyStatus(verdict.reason);
        // Only the sanitized reason is logged — never the body/signature/secret.
        logger.warn('unknown_event', { error_category: 'ashby_webhook_rejected', http_status: status });
        return res.status(status).json({ ok: false, error: verdict.reason });
      }

      // Signature verified over the exact bytes — parse the JSON transiently.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ ok: false, error: 'invalid_json' });
      }

      // M034 S03: only the two interview-schedule actions ever read the Meet configuration. With
      // the flag off they fall through to the unchanged generic ingress below.
      const action = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { action?: unknown }).action
        : undefined;
      if (isR1MeetAshbyScheduleAction(action)) {
        const route = meetRoute();
        if (route.kind === 'misconfigured') {
          // Retryable and loud: no receipt, no job, no clock read (S03-R4).
          logger.warn('unknown_event', {
            error_category: 'ashby_webhook_r1_meet',
            error_type: 'r1_meet_misconfigured',
            http_status: 503,
          });
          return res.status(503).json({ ok: false, error: 'r1_meet_misconfigured' });
        }
        if (route.kind === 'active') {
          const meet = route.meet;
          try {
            const ms = meetNow();
            const outcome = await ingestR1MeetAshbySchedule(parsed, {
              dexUserId: meet.ashby.dexUserId,
              receipts: resolveMeetReceipts(),
              receivedAtMs: ms,
              nowMs: ms,
            });
            // `code` is closed and sanitized (never a body, id, name or email).
            logger.info('unknown_event', {
              error_category: 'ashby_webhook_r1_meet',
              error_type: outcome.code,
              http_status: outcome.httpStatus,
            });
            if (outcome.refusal !== undefined) {
              logger.warn('unknown_event', {
                error_category: 'ashby_webhook_r1_meet_receipt_refused',
                error_type: outcome.refusal,
                http_status: outcome.httpStatus,
              });
            }
            if (outcome.httpStatus === 200) {
              return res.status(200).json({ ok: true, status: outcome.code });
            }
            return res.status(outcome.httpStatus).json({ ok: false, error: outcome.code });
          } catch {
            // Retryable: Ashby redelivers, and the dedupe keys converge.
            logger.warn('unknown_event', { error_category: 'ashby_webhook_r1_meet', error_type: 'internal_error', http_status: 500 });
            return res.status(500).json({ ok: false, error: 'internal_error' });
          }
        }
      }

      try {
        const outcome = await ingestWebhook(parsed, {
          receipts: resolveReceipts(),
        });
        // `code` is a closed, sanitized ingress result (never provider body,
        // ids, signature, or candidate data). This makes Ashby's one-shot
        // enablement handshake diagnosable without exposing webhook content.
        logger.info('unknown_event', {
          error_category: 'ashby_webhook_ingress',
          error_type: outcome.code,
          http_status: outcome.httpStatus,
        });
        if (outcome.httpStatus === 200) {
          return res.status(200).json({ ok: true, status: outcome.code });
        }
        return res.status(outcome.httpStatus).json({ ok: false, error: outcome.code });
      } catch {
        // Any unexpected internal failure is retryable — Ashby will redeliver.
        logger.warn('unknown_event', { error_category: 'ashby_webhook_internal', http_status: 500 });
        return res.status(500).json({ ok: false, error: 'internal_error' });
      }
    },
  );

  return router;
}

/** Default router instance (production wiring). */
export const ashbyWebhookRouter = createAshbyWebhookRouter();
