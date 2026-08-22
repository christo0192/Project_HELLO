/**
 * livekit-phone/config.ts — the enablement gate for the phone webhook ingress.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM phone-screening/config.ts ────
 * `lib/phone-screening/config.ts` owns the DOMAIN switches and the numeric
 * knobs, and a structural test forbids it from ever naming the LiveKit SDK or
 * a provider credential. The ingress needs BOTH the domain master switch and
 * a provisioned LiveKit key pair, so the conjunction lives here — outside the
 * domain core — and the core stays provider-free.
 *
 * ── NO NEW CREDENTIAL ─────────────────────────────────────────────────
 * `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` already exist in the api component
 * of `config/environment.schema.json`, already back `AccessToken`,
 * `RoomServiceClient` and `EgressClient`, and are the SAME pair LiveKit signs
 * its webhooks with. This phase introduces NO new provider secret and no new
 * environment variable at all: every knob it reads was provisioned by P2.
 *
 * ── FAIL CLOSED, TWICE ────────────────────────────────────────────────
 * The route is inert unless the MASTER domain switch is on AND a usable key
 * pair is present. Either one absent ⇒ a stable 503 and ZERO database or
 * network work. The credential is read as a presence boolean here; its VALUE
 * is handed only to the verifier and is never logged, returned or stored.
 */

import {
  loadPhoneScreeningConfig,
  type PhoneScreeningConfig,
} from '../../lib/phone-screening/index.js';

// Keep the env names visible to `scripts/check-env-contract.mjs`, which scans
// for literal `process.env.<VAR>` reads. Functional reads go through the
// injectable `source` map below. Both names are pre-existing api variables.
const _contractVisibleEnvReads = [
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
];
void _contractVisibleEnvReads;

/**
 * Shortest credential we will treat as provisioned. LiveKit keys and secrets
 * are far longer; this only rejects an empty or obviously-placeholder value so
 * a half-configured environment fails closed instead of failing at verify time.
 */
export const MIN_LIVEKIT_CREDENTIAL_LENGTH = 8;

/** Placeholder values that must never count as a provisioned credential. */
const PLACEHOLDERS = new Set(['replace_me', 'changeme', 'todo', 'devkey', 'secret']);

function credentialProvisioned(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (value.length < MIN_LIVEKIT_CREDENTIAL_LENGTH) return false;
  return !PLACEHOLDERS.has(value.toLowerCase());
}

export interface LiveKitPhoneConfig {
  /** The phone domain's numeric knobs and master switch (P2 owns these). */
  readonly phone: PhoneScreeningConfig;
  /** True iff BOTH LiveKit credentials look provisioned. Never their values. */
  readonly credentialsConfigured: boolean;
  /** The API key. Empty when unprovisioned. NEVER logged or returned. */
  readonly apiKey: string;
  /** The API secret. Empty when unprovisioned. NEVER logged or returned. */
  readonly apiSecret: string;
}

/**
 * Load the ingress config from an env map. Performs no I/O, opens no
 * connection, arms no timer and never throws — a malformed value degrades to
 * "not configured", which is the fail-closed answer.
 */
export function loadLiveKitPhoneConfig(
  source: NodeJS.ProcessEnv = process.env,
): LiveKitPhoneConfig {
  const apiKey = typeof source.LIVEKIT_API_KEY === 'string' ? source.LIVEKIT_API_KEY.trim() : '';
  const apiSecret =
    typeof source.LIVEKIT_API_SECRET === 'string' ? source.LIVEKIT_API_SECRET.trim() : '';
  const configured = credentialProvisioned(apiKey) && credentialProvisioned(apiSecret);
  return {
    phone: loadPhoneScreeningConfig(source),
    credentialsConfigured: configured,
    apiKey: configured ? apiKey : '',
    apiSecret: configured ? apiSecret : '',
  };
}

/**
 * True iff the webhook route may do ANY work at all.
 *
 * Deliberately gated on the MASTER switch (`PHONE_SCREENING_ENABLED`) and NOT
 * on `PHONE_RUNTIME_ENABLED`. The runtime flag arms the dialer; a webhook is
 * inbound. An operator who disarms the dialer mid-incident must still be able
 * to record the terminating events for calls already up, or those attempts
 * would hold fleet slots until their leases lapse.
 */
export function isPhoneWebhookActive(config: LiveKitPhoneConfig): boolean {
  return config.phone.screeningEnabled && config.credentialsConfigured;
}

/** Health-safe projection: booleans and counts only, never a credential. */
export function describeLiveKitPhoneConfig(config: LiveKitPhoneConfig): {
  screeningEnabled: boolean;
  credentialsConfigured: boolean;
  webhookActive: boolean;
  webhookMaxBytes: number;
  webhookToleranceSeconds: number;
} {
  return {
    screeningEnabled: config.phone.screeningEnabled,
    credentialsConfigured: config.credentialsConfigured,
    webhookActive: isPhoneWebhookActive(config),
    webhookMaxBytes: config.phone.webhookMaxBytes,
    webhookToleranceSeconds: config.phone.webhookToleranceSeconds,
  };
}
