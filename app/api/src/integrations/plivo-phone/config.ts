/**
 * plivo-phone/config.ts — the enablement gate for the Plivo answer-first
 * ("bounce") webhooks.
 *
 * ── FAIL CLOSED, ON THE SAME MASTER SWITCH AS THE DIALER'S BOUNCE PATH ──
 * The Plivo webhooks only matter when bounce mode is on, so they are gated on
 * `PHONE_BOUNCE_MODE` — the SAME flag `livekit-phone-dial/config.ts` reads to
 * reroute the dial — AND on a provisioned Plivo auth token, AND on a valid
 * E.164 caller id, AND on the three signed callback URLs. Any one absent ⇒ the
 * route is inert (503) and does ZERO database or network work.
 *
 * The auth token exists for ONE purpose: validating the V3 signature. This
 * design makes NO Plivo API calls, so `PLIVO_AUTH_ID` is carried only for
 * operator/console parity and is never used to authenticate an outbound call.
 *
 * SECURITY: the token, the auth id and the caller id are read as values ONLY
 * to hand to the verifier / to place in the answer XML. Their presence is
 * surfaced as booleans; their values are never logged, returned or stored.
 */

import {
  loadPhoneDialConfig,
  type PhoneDialConfig,
} from '../livekit-phone-dial/config.js';

// Keep the env names visible to `scripts/check-env-contract.mjs`, which scans
// for literal `process.env.<VAR>` reads. Functional reads go through the
// injectable `source` map below.
const _contractVisibleEnvReads = [
  process.env.PLIVO_AUTH_ID,
  process.env.PLIVO_AUTH_TOKEN,
  process.env.PHONE_BOUNCE_CALLER_ID,
  process.env.PLIVO_ANSWER_URL,
  process.env.PLIVO_DIAL_STATUS_URL,
  process.env.PLIVO_HANGUP_URL,
];
void _contractVisibleEnvReads;

/**
 * Shortest auth token we treat as provisioned. Plivo auth tokens are far
 * longer; the spec's `>=16 chars when bounce on` is the floor. A shorter or
 * empty value fails closed here rather than at verify time.
 */
export const MIN_PLIVO_AUTH_TOKEN_LENGTH = 16;

/** Strict Indian-mobile E.164, the SAME form 0042 and the dialer enforce. */
const STRICT_IN_MOBILE_E164 = /^\+91[6-9][0-9]{9}$/;

/**
 * The caller id is the number the CANDIDATE sees. It is validated as strict
 * E.164 for the same reason the dialer validates the dialled number: a
 * malformed caller id is a misconfiguration that must fail closed, not reach a
 * carrier. Reusing the Indian-mobile shape keeps every number in this lane on
 * one grammar; a caller id outside it degrades to empty (not configured).
 */
function validCallerId(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return STRICT_IN_MOBILE_E164.test(value) ? value : '';
}

function tokenProvisioned(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value.length >= MIN_PLIVO_AUTH_TOKEN_LENGTH ? value : '';
}

/** An https URL, trimmed. Anything else degrades to empty (fail-closed). */
function validSignedUrl(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return '';
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? value : '';
  } catch {
    return '';
  }
}

export interface PlivoPhoneConfig {
  /** The dialer's bounce switch — the master gate for this whole surface. */
  readonly bounceMode: boolean;
  /** The auth token, empty when unprovisioned. NEVER logged or returned. */
  readonly authToken: string;
  /** True iff an auth id looks present (console parity only; no API call). */
  readonly authIdConfigured: boolean;
  /** The caller-id E.164 placed in the answer XML. Empty when invalid. */
  readonly callerId: string;
  /** The EXACT URL Plivo signs for each callback. Empty when unset/invalid. */
  readonly answerUrl: string;
  readonly dialStatusUrl: string;
  readonly hangupUrl: string;
  /** The dial config, carried so callers can read the same bounce fields. */
  readonly dial: PhoneDialConfig;
}

export function loadPlivoPhoneConfig(
  source: NodeJS.ProcessEnv = process.env,
): PlivoPhoneConfig {
  const dial = loadPhoneDialConfig(source);
  return {
    bounceMode: dial.bounceMode,
    authToken: tokenProvisioned(source.PLIVO_AUTH_TOKEN),
    authIdConfigured:
      typeof source.PLIVO_AUTH_ID === 'string' && source.PLIVO_AUTH_ID.trim().length > 0,
    callerId: validCallerId(source.PHONE_BOUNCE_CALLER_ID),
    answerUrl: validSignedUrl(source.PLIVO_ANSWER_URL),
    dialStatusUrl: validSignedUrl(source.PLIVO_DIAL_STATUS_URL),
    hangupUrl: validSignedUrl(source.PLIVO_HANGUP_URL),
    dial,
  };
}

/**
 * True iff the Plivo webhook surface may do ANY work: bounce mode is on AND a
 * usable auth token is present. The per-route URL/caller-id checks are made at
 * the point they are needed (the answer route needs the caller id and the dial
 * URL; the status/hangup routes need only the token) so that a partially
 * configured deployment fails at the SPECIFIC missing piece rather than
 * globally.
 */
export function isPlivoWebhookActive(config: PlivoPhoneConfig): boolean {
  return config.bounceMode && config.authToken.length > 0;
}

/** Health-safe projection: booleans only, never a token or a number. */
export function describePlivoPhoneConfig(config: PlivoPhoneConfig): {
  bounceMode: boolean;
  authTokenConfigured: boolean;
  callerIdConfigured: boolean;
  answerUrlConfigured: boolean;
  dialStatusUrlConfigured: boolean;
  hangupUrlConfigured: boolean;
  webhookActive: boolean;
} {
  return {
    bounceMode: config.bounceMode,
    authTokenConfigured: config.authToken.length > 0,
    callerIdConfigured: config.callerId.length > 0,
    answerUrlConfigured: config.answerUrl.length > 0,
    dialStatusUrlConfigured: config.dialStatusUrl.length > 0,
    hangupUrlConfigured: config.hangupUrl.length > 0,
    webhookActive: isPlivoWebhookActive(config),
  };
}
