/**
 * Webhook signing double for the M034 Recall (Svix / Standard Webhooks) verifier (S01 plan T5),
 * shared with the Recall receivers' tests in a later slice (S03).
 *
 * The signer is written independently of the verifier (its own base64 decode and HMAC), so a
 * verifier test checks the verifier against a second implementation, not against itself.
 *
 * gitleaks scans the full PR history: every secret here is generated at run time from random
 * bytes, and the Svix prefix is assembled from two parts, so no prefixed base64 literal ever
 * appears in source.
 *
 * Never shipped: `tsconfig.build.json` excludes `src/__tests__`.
 */
import { createHmac, randomBytes } from 'node:crypto';

/** The Svix / Standard Webhooks secret prefix, assembled at run time. */
export const RECALL_WEBHOOK_SECRET_PREFIX_FOR_TESTS = 'whsec' + '_';

/** A fresh Recall workspace verification secret: the prefix + standard base64 of `bytes` random bytes. */
export function makeRecallWebhookSecret(bytes = 32): string {
  return RECALL_WEBHOOK_SECRET_PREFIX_FOR_TESTS + randomBytes(bytes).toString('base64');
}

/** `v1,<base64 HMAC-SHA256>` over `<id>.<timestamp>.` + body, keyed by the decoded secret. */
export function recallWebhookV1Signature(input: {
  secret: string;
  id: string;
  timestamp: number | string;
  body: string | Buffer;
}): string {
  const encoded = input.secret.startsWith(RECALL_WEBHOOK_SECRET_PREFIX_FOR_TESTS)
    ? input.secret.slice(RECALL_WEBHOOK_SECRET_PREFIX_FOR_TESTS.length)
    : input.secret;
  const hmacKey = Buffer.from(encoded, 'base64');
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
  const mac = createHmac('sha256', hmacKey)
    .update(Buffer.from(`${input.id}.${input.timestamp}.`, 'utf8'))
    .update(body)
    .digest('base64');
  return `v1,${mac}`;
}

/**
 * The three signed headers (lower-case names, as Express presents them) for a Recall delivery.
 * `headerStyle` picks `webhook-*` (default) or the legacy `svix-*`; `extraSignatures` are placed
 * BEFORE the real entry in the space-separated signature list.
 */
export function signRecallWebhook(input: {
  secret: string;
  id: string;
  timestamp: number | string;
  body: string | Buffer;
  headerStyle?: 'webhook' | 'svix';
  extraSignatures?: readonly string[];
}): Record<string, string> {
  const prefix = input.headerStyle === 'svix' ? 'svix' : 'webhook';
  const signature = [...(input.extraSignatures ?? []), recallWebhookV1Signature(input)].join(' ');
  return {
    [`${prefix}-id`]: input.id,
    [`${prefix}-timestamp`]: String(input.timestamp),
    [`${prefix}-signature`]: signature,
  };
}
