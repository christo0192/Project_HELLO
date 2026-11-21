/**
 * recall/settings.ts — pure validators and constants for the Recall.ai integration.
 *
 * Reads NO environment and performs no I/O: the Meet config reader (`lib/r1/meet/config.ts`) is the
 * only module that reads the variables, and it hands the values it read to these validators. The
 * REST client and the webhook verifier take the validated values as explicit arguments.
 *
 * SECURITY: nothing here logs, and no validator echoes its input in a result or an error.
 */

/**
 * Recall regions are separate accounts with their own keys and resources. Ours is Tokyo, the region
 * closest to India (decision D-M034-4).
 */
export const RECALL_DEFAULT_BASE_URL = 'https://ap-northeast-1.recall.ai';

/**
 * A bot whose `join_at` is at least 10 minutes away is a "scheduled" bot, which Recall guarantees
 * never fails with 507 (ad-hoc pool empty). Later slices create bots at least this far ahead.
 */
export const RECALL_SCHEDULED_BOT_MIN_LEAD_MS = 600_000;

/** What we send as `Idempotency-Key` (Recall caches key + method + path for an hour). */
export const RECALL_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** A Recall bot id: a lowercase UUID. Validated before any id is put into a request path. */
export const RECALL_BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The workspace verification secret is this prefix followed by standard base64. */
export const RECALL_WEBHOOK_SECRET_PREFIX = 'whsec_';

// ONE DNS label in front of `recall.ai`: `ap-northeast-1.recall.ai`, `us-east-1.recall.ai`,
// `api.recall.ai`. Never the bare apex, never a deeper name, never a look-alike apex.
const RECALL_HOST = /^[a-z0-9-]{1,63}\.recall\.ai$/;

const API_KEY_SHAPE = /^[\x21-\x7e]{16,256}$/;

// Standard (not URL-safe) base64, 16..64 decoded bytes, padding optional but exact if present.
const SECRET_BODY = /^[A-Za-z0-9+/]{22,88}={0,2}$/;
const SECRET_MIN_BYTES = 16;
const SECRET_MAX_BYTES = 64;

/**
 * The Recall API origin, e.g. `https://ap-northeast-1.recall.ai`, or null. Accepts an https origin
 * whose host is one label + `.recall.ai`; one trailing `/` is tolerated and removed. Rejects any
 * port (even `:443`), userinfo, path, query (even a bare `?`), fragment, upper-case spelling and
 * non-strings. A blank value is NOT defaulted here: the config reader maps blank to
 * `RECALL_DEFAULT_BASE_URL` before calling this.
 */
export function normalizeRecallBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const ok =
    url.protocol === 'https:' &&
    RECALL_HOST.test(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    // Byte-for-byte the origin: rejects `:443`, a bare `?` or `#`, upper case, stray whitespace.
    candidate === url.origin;
  return ok ? url.origin : null;
}

/**
 * Plausible API key: 16..256 printable ASCII characters. A pasted key with a stray space or newline
 * would only fail later as an opaque 401, so it is refused here.
 */
export function isRecallApiKeyShaped(raw: unknown): raw is string {
  return typeof raw === 'string' && API_KEY_SHAPE.test(raw);
}

/**
 * The HMAC key for webhook verification: the base64-decoded bytes after the `whsec_` prefix, or
 * null. Requires 16..64 decoded bytes and canonical base64 (the decoded bytes must re-encode to the
 * same text, padded or unpadded), so two different strings never verify as the same key.
 */
export function decodeRecallWebhookSecret(raw: unknown): Buffer | null {
  if (typeof raw !== 'string' || !raw.startsWith(RECALL_WEBHOOK_SECRET_PREFIX)) return null;
  const body = raw.slice(RECALL_WEBHOOK_SECRET_PREFIX.length);
  if (!SECRET_BODY.test(body)) return null;
  const decoded = Buffer.from(body, 'base64');
  if (decoded.length < SECRET_MIN_BYTES || decoded.length > SECRET_MAX_BYTES) return null;
  const canonical = decoded.toString('base64');
  if (body !== canonical && body !== canonical.replace(/=+$/, '')) return null;
  return decoded;
}

/** A lowercase UUID, safe to put into a request path. */
export function isRecallBotId(raw: unknown): raw is string {
  return typeof raw === 'string' && RECALL_BOT_ID_RE.test(raw);
}
