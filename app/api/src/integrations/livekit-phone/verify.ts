/**
 * livekit-phone/verify.ts — the ONLY trust boundary of the phone webhook.
 *
 * ── THIS IS NOT THE ASHBY ALGORITHM ───────────────────────────────────
 * Ashby signs with a bare `HMAC-SHA256(secret, rawBody)` in an
 * `Ashby-Signature: sha256=<hex>` header. LiveKit does something different and
 * the two must NOT be conflated: it sends a JWT in an `Authorize` header whose
 * `sha256` claim is the base64 digest of the request body, signed with the
 * SAME api key/secret pair used for `AccessToken`. Verification therefore has
 * THREE parts — the JWT signature, the issuer/expiry with an explicit clock
 * tolerance, and the body-hash claim — and re-implementing them by hand would
 * be a cryptographic rewrite of a vendor protocol. So the SDK's
 * `WebhookReceiver` performs it, behind an injectable port.
 *
 * ── RAW BYTES, AND A PROVABLE ROUND TRIP ──────────────────────────────
 * `WebhookReceiver.receive` takes a STRING and hashes it. The body arrives as
 * bytes. A lossy decode (an invalid UTF-8 sequence becomes U+FFFD) would
 * change the digest and fail verification anyway, but it would fail as
 * "signature mismatch" — indistinguishable from an attack. So the decode is
 * checked to round-trip back to the identical bytes BEFORE verification, and a
 * body that does not is refused as `body_not_utf8`. Raw-byte fidelity is
 * asserted, not assumed.
 *
 * ── `skipAuth` IS NEVER TRUE ──────────────────────────────────────────
 * The SDK's third parameter can disable verification entirely. It is passed
 * `false` explicitly, positionally, at the single call site, and a structural
 * test fails if `true` ever appears in this module.
 *
 * SECURITY: the body, the JWT and the credential pair are never logged,
 * returned, stored or embedded in an error. Failures are closed vocabulary.
 */

import { APPROVED_PARTICIPANT_ATTRIBUTES } from './events.js';
import type { LiveKitPhoneEnvelope } from './events.js';

/**
 * The header LiveKit signs into.
 *
 * Declared as a literal rather than re-exported from the SDK because this
 * module sits in `app.ts`'s import graph, and a static value import would make
 * every existing suite that partially mocks `livekit-server-sdk` fail to even
 * LOAD the app. A drift test in the P3 suite imports the SDK for real and
 * asserts this equals its `authorizeHeader`, so the literal cannot silently
 * diverge — the constant is mirrored, and the mirror is checked.
 */
export const LIVEKIT_AUTH_HEADER = 'Authorize';

/** Closed, sanitized failure vocabulary. Ordered as the checks run. */
export const PHONE_WEBHOOK_VERIFY_REASONS = [
  'not_configured',
  'empty_body',
  'body_too_large',
  'body_not_utf8',
  'missing_signature',
  'invalid_signature',
] as const;

export type PhoneWebhookVerifyReason = (typeof PHONE_WEBHOOK_VERIFY_REASONS)[number];

export type PhoneWebhookVerifyResult =
  | { readonly ok: true; readonly envelope: LiveKitPhoneEnvelope }
  | { readonly ok: false; readonly reason: PhoneWebhookVerifyReason };

export interface PhoneWebhookVerifyInput {
  readonly rawBody: Buffer;
  readonly authHeader: string | undefined | null;
}

/**
 * The DI seam. A test injects a deterministic fake; production injects the
 * SDK-backed implementation below. The route depends on this interface only,
 * so no test needs a real key pair and no verification is ever stubbed out in
 * production by a flag.
 */
export interface PhoneWebhookVerifier {
  verify(input: PhoneWebhookVerifyInput): Promise<PhoneWebhookVerifyResult>;
}

export interface CreateVerifierOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  /** Hard byte bound on the raw body (`PHONE_WEBHOOK_MAX_BYTES`). */
  readonly maxBytes: number;
  /** Explicit JWT clock tolerance in seconds (`PHONE_WEBHOOK_TOLERANCE_SECONDS`). */
  readonly toleranceSeconds: number;
}

/**
 * Reduce a participant's attribute map to the APPROVED KEYS ONLY.
 *
 * LiveKit populates SIP participants with `sip.phoneNumber`,
 * `sip.trunkPhoneNumber` and `sip.callID` automatically, so the raw map is a
 * subscriber number one property access away. The reduction happens HERE, at
 * the trust boundary, rather than one module inward: `events.ts` also gates
 * reads through the same allowlist, but a map that never enters the envelope
 * cannot be read by anything at all — including a future caller that reaches
 * for `envelope.participantAttributes` directly without knowing the rule.
 *
 * Indexed by exact key. The map is never enumerated, so an attribute LiveKit
 * adds in a future release is dropped by default rather than admitted by it.
 */
function approvedAttributesOnly(
  attributes: Record<string, string> | undefined,
): Readonly<Record<string, string>> | null {
  if (attributes === null || attributes === undefined || typeof attributes !== 'object') {
    return null;
  }
  const projected: Record<string, string> = {};
  for (const key of APPROVED_PARTICIPANT_ATTRIBUTES) {
    const value = (attributes as Record<string, unknown>)[key];
    if (typeof value === 'string') projected[key] = value;
  }
  return projected;
}

/**
 * Project the SDK's `WebhookEvent` onto the narrow envelope this integration
 * reads. Everything not named here — room metadata, tracks, egress info, the
 * participant's name and every unapproved attribute including the
 * automatically-populated `sip.*` ones — is dropped AT THE BOUNDARY rather
 * than carried inward and filtered later. That sentence is literal: the raw
 * attribute map does not survive this function.
 */
function toEnvelope(event: {
  event?: string;
  id?: string;
  participant?: { identity?: string; attributes?: Record<string, string> };
}): LiveKitPhoneEnvelope {
  return {
    event: typeof event.event === 'string' ? event.event : '',
    id: typeof event.id === 'string' ? event.id : null,
    participantIdentity:
      typeof event.participant?.identity === 'string' ? event.participant.identity : null,
    participantAttributes: approvedAttributesOnly(event.participant?.attributes),
  };
}

/**
 * Build the production verifier. Constructing it does no I/O and opens no
 * connection; `WebhookReceiver` is a pure JWT/hash validator.
 */
export function createPhoneWebhookVerifier(options: CreateVerifierOptions): PhoneWebhookVerifier {
  const { apiKey, apiSecret, maxBytes, toleranceSeconds } = options;
  // The SDK is loaded lazily, on the first body that actually reaches
  // verification, so a disabled deployment never CONSTRUCTS a receiver.
  let receiver: { receive(body: string, auth?: string, skip?: boolean, tol?: number): Promise<unknown> } | undefined;

  return {
    async verify({ rawBody, authHeader }: PhoneWebhookVerifyInput): Promise<PhoneWebhookVerifyResult> {
      if (apiKey.length === 0 || apiSecret.length === 0) {
        return { ok: false, reason: 'not_configured' };
      }
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        return { ok: false, reason: 'empty_body' };
      }
      if (rawBody.length > maxBytes) {
        return { ok: false, reason: 'body_too_large' };
      }
      const body = rawBody.toString('utf8');
      // Raw-byte fidelity: a lossy decode must not be reported as a mismatch.
      if (!Buffer.from(body, 'utf8').equals(rawBody)) {
        return { ok: false, reason: 'body_not_utf8' };
      }
      if (typeof authHeader !== 'string' || authHeader.trim().length === 0) {
        return { ok: false, reason: 'missing_signature' };
      }

      if (!receiver) {
        // Loaded here, not at module scope. NOTE: this does not mean the SDK
        // is absent from a disabled process — `routes/invites.ts`,
        // `lib/room-provisioning.ts` and `lib/recording-egress.ts` all import
        // it statically and are all in app.ts's graph. The reason is the one
        // stated on LIVEKIT_AUTH_HEADER above: a static value import here
        // would break every existing suite that partially mocks the SDK.
        const { WebhookReceiver } = await import('livekit-server-sdk');
        receiver = new WebhookReceiver(apiKey, apiSecret);
      }
      try {
        // Positional: (body, authHeader, skipAuth=false, clockTolerance).
        // `false` is written literally — verification is never skippable.
        const event = await receiver.receive(body, authHeader, false, toleranceSeconds);
        return { ok: true, envelope: toEnvelope(event as never) };
      } catch {
        // Every failure mode of `receive` — malformed JWT, bad signature,
        // expired beyond tolerance, body-hash mismatch — collapses to one
        // sanitized reason. The thrown message may quote the token, so it is
        // discarded here and never reaches a log or a response.
        return { ok: false, reason: 'invalid_signature' };
      }
    },
  };
}
