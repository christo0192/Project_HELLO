/**
 * routes/plivo-webhook.ts — the Plivo answer-first ("bounce") callbacks.
 *
 *   POST /api/integrations/plivo/answer       (the SIP endpoint answer URL)
 *   POST /api/integrations/plivo/dial-status  (the <Dial> action callback)
 *   POST /api/integrations/plivo/hangup       (the app hangup callback)
 *
 * ── WHY THIS SURFACE EXISTS ───────────────────────────────────────────
 * LiveKit Cloud's outbound-SIP state machine never registers the answer on our
 * Plivo Zentrunk calls and kills every live call ~45 s after INVITE — proven by
 * eight live reproductions, server-side, ignoring all per-call options. Plivo's
 * OWN answer supervision works. So in bounce mode LiveKit dials a Plivo
 * VOICE-APP SIP ENDPOINT that answers INSTANTLY (LiveKit sees an answered call
 * in ~1 s; its timers are satisfied forever), and Plivo's app then dials the
 * candidate and bridges. These callbacks are how Plivo's app asks us what to do
 * on answer, tells us the dial result, and reports its own hangup.
 *
 * ── MOUNTED BEFORE AUTH, MASTER-SWITCH-GATED ──────────────────────────
 * Like the Ashby and LiveKit webhooks, this is mounted ahead of recruiter auth:
 * its ONLY trust boundary is the Plivo V3 signature over the request. It is
 * gated on `PHONE_BOUNCE_MODE` + a configured Plivo auth token; disabled or
 * unconfigured returns 503 having made NO database and NO network call. It is
 * still covered by the global per-IP limiter mounted earlier, plus this
 * router's own scoped body-size bound.
 *
 * ── FAIL-CLOSED, NEVER ECHO A PARAM ───────────────────────────────────
 * Plivo params carry phone numbers (`To`, `From`, `CallerName`, the forwarded
 * `X-PH-*` headers). NOTHING here logs, echoes or returns a param. The answer
 * XML carries the candidate number and is treated as the response body only.
 * Every route responds with Plivo XML: on any missing/invalid/terminal
 * precondition the answer route returns `<Response><Hangup/></Response>`.
 *
 * ── MID-CALL CANDIDATE HANGUPS NEED NO NEW LOGIC ──────────────────────
 * When the candidate hangs up mid-conversation, Plivo tears down its bridged
 * leg and the SIP participant LEAVES the LiveKit room. That drives the EXISTING
 * paths (`sip.participant_left` via the LiveKit webhook / the worker), which
 * already end the attempt and drive the engagement. The `/hangup` callback here
 * is Plivo's APPLICATION hangup notification; it is logged as a fixed string
 * and 200'd, and deliberately performs no state transition of its own.
 */

import express, { Router, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import {
  loadPlivoPhoneConfig,
  isPlivoWebhookActive,
  type PlivoPhoneConfig,
} from '../integrations/plivo-phone/config.js';
import {
  verifyPlivoSignature,
  PLIVO_SIGNATURE_HEADER,
  PLIVO_NONCE_HEADER,
  type PlivoVerifyReason,
} from '../integrations/plivo-phone/verify.js';
import {
  createPlivoBounceStore,
  type PlivoBounceStore,
} from '../integrations/plivo-phone/stores.js';
import { buildPlivoAnswerXml, PLIVO_HANGUP_XML } from '../integrations/plivo-phone/xml.js';
import { unwrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import { createPhoneStores, type PhoneStores } from '../lib/phone-screening/index.js';

/** Transport ceiling — a Plivo callback body is small form-encoded metadata. */
const TRANSPORT_BODY_LIMIT = '256kb';

/** A lowercase-hex uuid, the form `x-hello-attempt` carries. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The forwarded SIP-header param, case-insensitive. The bounce trunk maps our
 * `x-hello-attempt` participant attribute to the SIP header `X-PH-HELLO-ATTEMPT`,
 * and Plivo delivers a forwarded `X-PH-*` header to the answer callback as a
 * request PARAM named `X-PH-Hello-Attempt` — but casing varies by path, so the
 * param name is matched case-insensitively against this canonical form.
 */
const HELLO_ATTEMPT_PARAM = 'x-ph-hello-attempt';

/** Read a param case-insensitively from a parsed form body. */
function readParamCaseInsensitive(
  body: Record<string, unknown>,
  wantLower: string,
): string | undefined {
  for (const key of Object.keys(body)) {
    if (key.toLowerCase() === wantLower) {
      const v = body[key];
      // Plivo never repeats these, but a duplicated key parses to an array; a
      // non-string / array value is treated as absent (fail-closed).
      return typeof v === 'string' ? v : undefined;
    }
  }
  return undefined;
}

/** The DialStatus values Plivo reports on the action callback. */
const DIAL_ANSWERED = 'answer';
/** Non-answer terminal dial results — each charges a no-answer/provider outcome. */
const DIAL_BUSY = 'busy';

export interface PlivoWebhookRouterDeps {
  config?: PlivoPhoneConfig;
  /** The bounce read store (candidate number + attempt liveness). */
  bounceStore?: PlivoBounceStore;
  /** The phone stores, for `applyEvent` on the dial-status callback. */
  stores?: Pick<PhoneStores, 'applyEvent'>;
  /** Injected clock. Production uses the wall clock; tests pin it. */
  clock?: () => Date;
  loggerComponent?: string;
}

/**
 * Verify a request's Plivo V3 signature against the given signed URL and parsed
 * params. Returns the closed reason on failure. Factored out so all three
 * routes verify identically.
 */
function verifyRequest(
  config: PlivoPhoneConfig,
  signedUrl: string,
  req: Request,
): { ok: true } | { ok: false; reason: PlivoVerifyReason } {
  const body = (req.body ?? {}) as Record<string, string | string[]>;
  // Only string / string[] params participate in the V3 string.
  const params: Record<string, string | readonly string[]> = {};
  for (const key of Object.keys(body)) {
    const v = body[key];
    if (typeof v === 'string' || Array.isArray(v)) params[key] = v as string | string[];
  }
  return verifyPlivoSignature(config.authToken, {
    signedUrl,
    params,
    signatureHeader: req.header(PLIVO_SIGNATURE_HEADER),
    nonceHeader: req.header(PLIVO_NONCE_HEADER),
  });
}

export function createPlivoWebhookRouter(deps: PlivoWebhookRouterDeps = {}): Router {
  const router = Router();
  const logger = createLogger(deps.loggerComponent ?? 'plivo-webhook');
  const clock = deps.clock ?? (() => new Date());

  let cachedStore: PlivoBounceStore | undefined = deps.bounceStore;
  let cachedStores: Pick<PhoneStores, 'applyEvent'> | undefined = deps.stores;

  function resolveConfig(): PlivoPhoneConfig {
    return deps.config ?? loadPlivoPhoneConfig();
  }
  function resolveStore(): PlivoBounceStore {
    if (!cachedStore) cachedStore = createPlivoBounceStore(supabase as never);
    return cachedStore;
  }
  function resolveStores(): Pick<PhoneStores, 'applyEvent'> {
    if (!cachedStores) cachedStores = createPhoneStores(supabase as never);
    return cachedStores;
  }

  // Scoped urlencoded parser: Plivo posts form-encoded params, and this router
  // is mounted ABOVE the global JSON parser. The V3 signature is over the
  // PARAMS, so parsing must happen before verification. `extended: false` keeps
  // values as strings / string arrays, which is exactly what the V3 string
  // builder expects.
  const parseForm = express.urlencoded({ extended: false, limit: TRANSPORT_BODY_LIMIT });

  // Send Plivo XML with the correct content type. The body is NEVER logged.
  function sendXml(res: Response, xml: string): void {
    res.status(200).type('text/xml').send(xml);
  }

  // ── POST /answer ────────────────────────────────────────────────────
  router.post('/answer', parseForm, async (req: Request, res: Response) => {
    const config = resolveConfig();
    if (!isPlivoWebhookActive(config)) {
      // Inert: no store, no verify, no DB. A disabled deployment answers 503.
      return res.status(503).json({ ok: false, error: 'plivo_webhook_disabled' });
    }
    // The answer route additionally needs the caller id and the dial-status
    // action URL, plus the URL Plivo signed for THIS callback. Missing any is a
    // misconfiguration — fail closed with a hangup, not a bridge.
    if (config.callerId === '' || config.dialStatusUrl === '' || config.answerUrl === '') {
      logger.warn('unknown_event', {
        error_category: 'plivo_answer_misconfigured',
        http_status: 200,
      });
      return sendXml(res, PLIVO_HANGUP_XML);
    }

    const verdict = verifyRequest(config, config.answerUrl, req);
    if (!verdict.ok) {
      logger.warn('unknown_event', {
        error_category: 'plivo_signature_rejected',
        error_type: verdict.reason,
        http_status: 200,
      });
      return sendXml(res, PLIVO_HANGUP_XML);
    }

    const attemptId = readParamCaseInsensitive(
      (req.body ?? {}) as Record<string, unknown>,
      HELLO_ATTEMPT_PARAM,
    );
    if (attemptId === undefined || !UUID_RE.test(attemptId)) {
      logger.warn('unknown_event', {
        error_category: 'plivo_answer_no_correlation',
        http_status: 200,
      });
      return sendXml(res, PLIVO_HANGUP_XML);
    }

    try {
      const resolution = await resolveStore().resolveForAnswer(attemptId);
      if (!resolution.bridgeable || resolution.candidateNumber === undefined) {
        // Unknown, terminal, already-classified, or no dialable number: hang up.
        logger.info('unknown_event', {
          error_category: 'plivo_answer_not_bridgeable',
          http_status: 200,
        });
        return sendXml(res, PLIVO_HANGUP_XML);
      }
      // THE ONE UNWRAP on this path, at the single XML-build site. The returned
      // string carries the candidate number and is sent as the body ONLY.
      const xml = buildPlivoAnswerXml({
        candidateE164: unwrapDialableNumber(resolution.candidateNumber),
        callerId: config.callerId,
        actionUrl: config.dialStatusUrl,
      });
      logger.info('unknown_event', {
        error_category: 'plivo_answer_bridged',
        http_status: 200,
      });
      return sendXml(res, xml);
    } catch {
      // A read fault: we cannot prove the leg is bridgeable, so hang up. The
      // error is discarded (it could quote a row).
      logger.warn('unknown_event', {
        error_category: 'plivo_answer_error',
        http_status: 200,
      });
      return sendXml(res, PLIVO_HANGUP_XML);
    }
  });

  // ── POST /dial-status ───────────────────────────────────────────────
  // The <Dial> action callback. On DialStatus=answer, apply `call.answered`
  // through the SAME `apply_phone_event` seam the worker uses — the 0067
  // post-apply hook (in the worker route) attaches recording/egress/stamp; here
  // we drive only the ledger transition, idempotently. On busy/no-answer/
  // failure/cancel, apply the outcome the system already charges via the
  // existing `sip.originate_*` provider events (no 0068 needed — see the report).
  router.post('/dial-status', parseForm, async (req: Request, res: Response) => {
    const config = resolveConfig();
    if (!isPlivoWebhookActive(config)) {
      return res.status(503).json({ ok: false, error: 'plivo_webhook_disabled' });
    }
    if (config.dialStatusUrl === '') {
      logger.warn('unknown_event', {
        error_category: 'plivo_dial_status_misconfigured',
        http_status: 200,
      });
      return sendXml(res, PLIVO_HANGUP_XML);
    }
    const verdict = verifyRequest(config, config.dialStatusUrl, req);
    if (!verdict.ok) {
      logger.warn('unknown_event', {
        error_category: 'plivo_signature_rejected',
        error_type: verdict.reason,
        http_status: 200,
      });
      return sendXml(res, PLIVO_HANGUP_XML);
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const attemptId = readParamCaseInsensitive(body, HELLO_ATTEMPT_PARAM);
    const dialStatus = (readParamCaseInsensitive(body, 'dialstatus') ?? '').toLowerCase();
    // Plivo's CallUUID makes the ledger dedup deterministic across redeliveries.
    const callUuid = readParamCaseInsensitive(body, 'calluuid');
    if (attemptId === undefined || !UUID_RE.test(attemptId)) {
      logger.warn('unknown_event', {
        error_category: 'plivo_dial_status_no_correlation',
        http_status: 200,
      });
      // Nothing to record. Acknowledge so Plivo does not storm.
      return sendXml(res, PLIVO_HANGUP_XML);
    }

    try {
      if (dialStatus === DIAL_ANSWERED) {
        // The SAME event the worker posts on answer. `internal` mints a
        // deterministic synthetic provider id, so a redelivery converges on the
        // original verdict; the worker's own `call.answered` (if it also posts)
        // dedups against the ledger. This drives only the ledger transition —
        // the recording/egress/stamp hook lives on the worker route.
        await resolveStores().applyEvent({
          source: 'internal',
          eventType: 'call.answered',
          attemptId,
          now: clock(),
        });
        logger.info('unknown_event', {
          error_category: 'plivo_dial_status_answered',
          http_status: 200,
        });
        return sendXml(res, PLIVO_HANGUP_XML);
      }

      // busy / no-answer / failure / cancel / timeout — a never-answered dial.
      // The system already charges this via the provider `sip.originate_*`
      // events from `dialing`: `busy` → `sip.originate_rejected_busy`, and every
      // other non-answer → `sip.originate_timeout` (the ring-timeout outcome the
      // legacy path produced). Both are `provider_callback` events keyed on the
      // Plivo CallUUID so a redelivery dedups.
      const eventType =
        dialStatus === DIAL_BUSY ? 'sip.originate_rejected_busy' : 'sip.originate_timeout';
      await resolveStores().applyEvent({
        source: 'provider_callback',
        eventType,
        attemptId,
        // Deterministic per-dial id; absent CallUUID falls back to the attempt
        // + status so a missing id still dedups within the transition.
        providerEventId: `plivo:${callUuid ?? attemptId}:${eventType}`,
        now: clock(),
      });
      logger.info('unknown_event', {
        error_category: 'plivo_dial_status_no_answer',
        http_status: 200,
      });
      return sendXml(res, PLIVO_HANGUP_XML);
    } catch {
      // A store fault. Ask Plivo to redeliver via a 500; the deterministic id
      // makes that safe. The XML content type is dropped for the error path.
      logger.warn('unknown_event', {
        error_category: 'plivo_dial_status_error',
        http_status: 500,
      });
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // ── POST /hangup ────────────────────────────────────────────────────
  // The app hangup callback. Signature-validated, logged as a FIXED string, and
  // 200'd. It performs NO state transition: a mid-call candidate hangup already
  // drives the existing `sip.participant_left` path when the SIP leg leaves the
  // LiveKit room (see the route header). This callback exists so Plivo has a
  // place to POST its hangup and so its receipt is observable.
  router.post('/hangup', parseForm, async (req: Request, res: Response) => {
    const config = resolveConfig();
    if (!isPlivoWebhookActive(config)) {
      return res.status(503).json({ ok: false, error: 'plivo_webhook_disabled' });
    }
    if (config.hangupUrl === '') {
      logger.warn('unknown_event', {
        error_category: 'plivo_hangup_misconfigured',
        http_status: 200,
      });
      return res.status(200).json({ ok: true });
    }
    const verdict = verifyRequest(config, config.hangupUrl, req);
    if (!verdict.ok) {
      logger.warn('unknown_event', {
        error_category: 'plivo_signature_rejected',
        error_type: verdict.reason,
        http_status: 200,
      });
      return res.status(200).json({ ok: true });
    }
    logger.info('unknown_event', {
      error_category: 'plivo_hangup_received',
      http_status: 200,
    });
    return res.status(200).json({ ok: true });
  });

  return router;
}

/** Default router instance (production wiring). */
export const plivoWebhookRouter = createPlivoWebhookRouter();
