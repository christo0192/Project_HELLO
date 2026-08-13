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
import {
  createReceiptStore,
  createSignalEnqueuer,
  createAshbySignalQueue,
} from '../integrations/ashby/stores.js';
import type { ReceiptStore, SignalEnqueuer } from '../integrations/ashby/ports.js';

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
  /** Durable receipt store (defaults to the service-role Supabase store). */
  receipts?: ReceiptStore;
  /** Signal enqueuer (defaults to the leased Supabase queue). Omit to disable. */
  enqueuer?: SignalEnqueuer;
  /** Raw-body byte bound for signature verification. */
  maxBytes?: number;
  /** Metadata-only logger component name. */
  loggerComponent?: string;
}

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
  let cachedEnqueuer: SignalEnqueuer | undefined = deps.enqueuer;
  let enqueuerResolved = deps.enqueuer !== undefined;

  function resolveConfig(): AshbyIntegrationConfig {
    return deps.config ?? loadAshbyConfig();
  }
  function resolveReceipts(): ReceiptStore {
    if (!cachedReceipts) cachedReceipts = createReceiptStore(supabase as never);
    return cachedReceipts;
  }
  function resolveEnqueuer(): SignalEnqueuer {
    if (!enqueuerResolved) {
      cachedEnqueuer = createSignalEnqueuer(createAshbySignalQueue(supabase as never));
      enqueuerResolved = true;
    }
    // cachedEnqueuer may be intentionally undefined when injected as such.
    return cachedEnqueuer as SignalEnqueuer;
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

      try {
        const outcome = await ingestWebhook(parsed, {
          receipts: resolveReceipts(),
          enqueuer: resolveEnqueuer(),
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
