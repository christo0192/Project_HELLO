/**
 * routes/phone-webhook.ts — inbound LiveKit phone webhook receiver.
 *
 * POST /api/integrations/livekit-phone/webhook
 *
 * ── MOUNTED BEFORE AUTH, PUBLIC ONLY AT THIS EXACT PATH ───────────────
 * Mounted ahead of the recruiter-auth middleware, like the Ashby webhook and
 * the internal worker-assess router: its trust boundary is the LiveKit-signed
 * `Authorize` JWT over the exact raw bytes, not a recruiter session. Only
 * `POST /webhook` is declared on the router, so ANY other method or path under
 * the mount prefix falls through to the auth middleware and is rejected — the
 * public surface is one method-and-path pair, not a prefix. That is asserted
 * by test rather than left to the reader.
 *
 * It is still covered by the global per-IP rate limiter, which is mounted
 * earlier still. No rate-limit or CSP behaviour is changed by this route.
 *
 * ── FAIL-CLOSED ORDER ─────────────────────────────────────────────────
 * active? → raw-body bound → JWT/body-hash verify → event classification →
 * `apply_phone_event` → 2xx. Disabled or unconfigured returns 503 having made
 * no database and no network call at all.
 *
 * ── 200 vs 500 ────────────────────────────────────────────────────────
 * 200 means the database reached a verdict and any durable row it implies is
 * committed — including for a duplicate, which returns the FIRST delivery's
 * outcome. 500 means we cannot say what happened, so LiveKit should redeliver.
 * A signed body we cannot interpret is a non-retryable 400 so a
 * misconfiguration is loud instead of becoming a redelivery storm.
 *
 * SECURITY: the raw body, the JWT, the credentials, every participant
 * attribute and every provider payload field are never logged, persisted or
 * returned. Responses carry a closed, sanitized status token only.
 */

import express, { Router, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { createPhoneStores, type PhoneStores } from '../lib/phone-screening/index.js';
import {
  loadLiveKitPhoneConfig,
  isPhoneWebhookActive,
  type LiveKitPhoneConfig,
} from '../integrations/livekit-phone/config.js';
import {
  createPhoneWebhookVerifier,
  LIVEKIT_AUTH_HEADER,
  type PhoneWebhookVerifier,
  type PhoneWebhookVerifyReason,
} from '../integrations/livekit-phone/verify.js';
import {
  ingestPhoneWebhook,
  phoneIngressHealth,
  type PhoneIngressHealth,
} from '../integrations/livekit-phone/ingress.js';

/** Transport ceiling. The SEMANTIC bound is `PHONE_WEBHOOK_MAX_BYTES`. */
const TRANSPORT_BODY_LIMIT = '1mb';

/** Map a verification failure to a fail-closed HTTP status. */
export function phoneVerifyStatus(reason: PhoneWebhookVerifyReason): 400 | 401 | 403 | 413 | 503 {
  switch (reason) {
    case 'not_configured': return 503;
    case 'empty_body': return 400;
    case 'body_too_large': return 413;
    case 'body_not_utf8': return 400;
    case 'missing_signature': return 401;
    case 'invalid_signature': return 403;
  }
}

export interface PhoneWebhookRouterDeps {
  config?: LiveKitPhoneConfig;
  verifier?: PhoneWebhookVerifier;
  stores?: Pick<PhoneStores, 'applyEvent'>;
  health?: PhoneIngressHealth;
  /** Injected clock. Production uses the wall clock; tests pin it. */
  clock?: () => Date;
  loggerComponent?: string;
}

/**
 * Build the phone webhook router. Every dependency is lazily resolved, so a
 * disabled deployment constructs no Supabase store, no LiveKit receiver and no
 * verifier — the 503 path genuinely touches nothing.
 */
export function createPhoneWebhookRouter(deps: PhoneWebhookRouterDeps = {}): Router {
  const router = Router();
  const logger = createLogger(deps.loggerComponent ?? 'phone-webhook');
  const clock = deps.clock ?? (() => new Date());

  let cachedStores: Pick<PhoneStores, 'applyEvent'> | undefined = deps.stores;
  let cachedVerifier: PhoneWebhookVerifier | undefined = deps.verifier;

  function resolveConfig(): LiveKitPhoneConfig {
    return deps.config ?? loadLiveKitPhoneConfig();
  }
  function resolveStores(): Pick<PhoneStores, 'applyEvent'> {
    if (!cachedStores) cachedStores = createPhoneStores(supabase as never);
    return cachedStores;
  }
  function resolveVerifier(config: LiveKitPhoneConfig): PhoneWebhookVerifier {
    if (!cachedVerifier) {
      cachedVerifier = createPhoneWebhookVerifier({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        maxBytes: config.phone.webhookMaxBytes,
        toleranceSeconds: config.phone.webhookToleranceSeconds,
      });
    }
    return cachedVerifier;
  }

  router.post(
    '/webhook',
    express.raw({ type: '*/*', limit: TRANSPORT_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      const config = resolveConfig();

      // Master switch off, or no LiveKit key pair: no verify, no store, no
      // network call, no database call.
      if (!isPhoneWebhookActive(config)) {
        return res.status(503).json({ ok: false, error: 'phone_webhook_disabled' });
      }

      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const authHeader = req.header(LIVEKIT_AUTH_HEADER) ?? undefined;

      const verdict = await resolveVerifier(config).verify({ rawBody, authHeader });
      if (!verdict.ok) {
        const status = phoneVerifyStatus(verdict.reason);
        // Only the closed reason token — never the body, JWT or credential.
        logger.warn('unknown_event', {
          error_category: 'phone_webhook_rejected',
          error_type: verdict.reason,
          http_status: status,
        });
        return res.status(status).json({ ok: false, error: verdict.reason });
      }

      try {
        const health = deps.health ?? phoneIngressHealth;
        const outcome = await ingestPhoneWebhook(verdict.envelope, {
          stores: resolveStores(),
          health,
          now: clock(),
        });

        if (!outcome.recorded && outcome.httpStatus === 200 && outcome.code !== 'ignored_not_phone') {
          // P1 residual R-4: `apply_phone_event` refused BEFORE its insert, so
          // no ledger row exists and `phone_backlog` cannot count it. One
          // warn per occurrence under a dedicated category is the countable
          // surface; `phoneIngressHealth.snapshot()` is the in-process one a
          // health route can read later. The running total is deliberately
          // NOT passed as metadata: `count` is not an allowlisted logger key
          // and would be dropped silently, which is worse than absent.
          logger.warn('unknown_event', {
            error_category: 'phone_ingress_unrecorded',
            error_type: outcome.code,
            http_status: 200,
          });
        } else {
          logger.info('unknown_event', {
            error_category: 'phone_webhook_ingress',
            error_type: outcome.code,
            http_status: outcome.httpStatus,
          });
        }

        if (outcome.httpStatus === 200) {
          return res.status(200).json({ ok: true, status: outcome.code });
        }
        return res.status(outcome.httpStatus).json({ ok: false, error: outcome.code });
      } catch {
        // We do not know whether the verdict committed. Ask for a redelivery;
        // the deterministic provider event id makes that safe.
        logger.warn('unknown_event', {
          error_category: 'phone_webhook_internal',
          http_status: 500,
        });
        return res.status(500).json({ ok: false, error: 'internal_error' });
      }
    },
  );

  return router;
}

/** Default router instance (production wiring). */
export const phoneWebhookRouter = createPhoneWebhookRouter();
