/**
 * OBS-02: Correlation ID propagation.
 *
 * Accepts a canonical UUID v4 from X-Correlation-ID on trusted inbound
 * requests; rejects malformed, oversized, control-character, and
 * comma-joined (duplicate) values — generates a crypto-strong UUID when
 * absent or invalid. Returns X-Correlation-ID on every response including
 * CORS-blocked, preflight, validation-error, and 5xx paths.
 *
 * Request context is isolated per-request via AsyncLocalStorage; no
 * context bleed under concurrent load.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const INCOMING_HEADER = 'x-correlation-id'; // Express normalises to lowercase
const OUTGOING_HEADER = 'X-Correlation-ID';
const MAX_ID_LEN = 128;

/** UUID v4 canonical pattern — only format accepted from callers. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Context {
  readonly correlationId: string;
}

const store = new AsyncLocalStorage<Context>();

/** Returns the current request's correlation ID, or null outside request context. */
export function getCorrelationId(): string | null {
  return store.getStore()?.correlationId ?? null;
}

/**
 * Validate an incoming X-Correlation-ID value.
 *
 * Rejects:
 *  - Array values (Node.js never produces them for non-set-cookie, but guard anyway)
 *  - Values containing commas (Node.js joins duplicate headers with ", ")
 *  - Values longer than MAX_ID_LEN (64 bytes would suffice; 128 is generous)
 *  - Values containing control characters (0x00–0x1F, 0x7F)
 *  - Values that do not match UUID v4 format
 *
 * Returns the lower-cased UUID on acceptance, null on rejection.
 *
 * Exported for unit tests; do not call directly in application code — use
 * correlationMiddleware instead.
 */
export function validateIncomingId(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return null;
  if (raw.includes(',')) return null;
  if (raw.length > MAX_ID_LEN) return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return null;
  }
  const trimmed = raw.trim();
  if (!UUID_V4_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Express middleware: resolve or generate a correlation ID, attach it to the
 * response header, and run subsequent handlers inside an isolated async context.
 *
 * Must be registered before all routes and error handlers in createApp().
 */
export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const raw = req.headers[INCOMING_HEADER];
  const validated = validateIncomingId(raw);
  const correlationId = validated ?? randomUUID();

  // Set header synchronously before next() so it is present on every response
  // path including CORS callbacks and error handlers that call res.json().
  res.setHeader(OUTGOING_HEADER, correlationId);

  store.run({ correlationId }, next);
}
