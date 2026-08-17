/**
 * ashby/config.ts — integration enablement + webhook secret gating.
 *
 * The Ashby integration is DISABLED BY DEFAULT. It only becomes active when
 * BOTH an explicit `ASHBY_INTEGRATION_ENABLED=true` flag is set AND a usable
 * `ASHBY_WEBHOOK_SECRET` is provisioned. When inactive, the webhook route fails
 * closed (503, no verification, no receipt, no queue work) and no reconciliation
 * loop or outbound Ashby call is ever performed — the module makes no network
 * calls in the default configuration.
 *
 * SECURITY: the secret value is loaded from the validated env-name contract
 * only. It is NEVER logged, printed, returned, or embedded in errors — callers
 * receive `webhookSecretConfigured` (a boolean) for health/metadata and the raw
 * value solely to hand to the constant-time verifier. `describeAshbyConfig`
 * exposes only booleans, never the secret.
 */

// Keep the two Ashby env names visible to the env-contract checker, which
// scans for `process.env.<VAR>` literals. The functional reads go through the
// injectable `source` map below (defaulting to process.env).
const _contractVisibleEnvReads = [
  process.env.ASHBY_INTEGRATION_ENABLED,
  process.env.ASHBY_WEBHOOK_SECRET,
  process.env.ASHBY_API_KEY,
  process.env.ASHBY_RUNTIME_ENABLED,
  process.env.ASHBY_RESUME_HOSTS,
  process.env.ASHBY_SIGNAL_POLL_MS,
  process.env.ASHBY_OPERATION_POLL_MS,
  process.env.ASHBY_RECONCILE_INTERVAL_MS,
  process.env.ASHBY_RECLAIM_INTERVAL_MS,
  process.env.ASHBY_LEASE_SECONDS,
];
void _contractVisibleEnvReads;

/** Minimum accepted webhook secret length (rejects trivially short secrets). */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

/** Minimum accepted API-key length (rejects trivially short/placeholder keys). */
export const MIN_API_KEY_LENGTH = 16;

/** Placeholder value used in `.env.example`; never treated as a real secret. */
const SECRET_PLACEHOLDER = 'replace_me';

export interface AshbyIntegrationConfig {
  /** Explicit master switch (`ASHBY_INTEGRATION_ENABLED=true`). Default false. */
  enabled: boolean;
  /** True iff a non-placeholder secret of sufficient length is provisioned. */
  webhookSecretConfigured: boolean;
  /** The raw webhook secret — for the verifier only; never log or return it. */
  webhookSecret: string;
}

/**
 * Load the Ashby integration config from an env map (defaults to process.env).
 * Reads only the two contract env names; performs no I/O and no network call.
 */
export function loadAshbyConfig(
  source: NodeJS.ProcessEnv = process.env,
): AshbyIntegrationConfig {
  const enabled = source.ASHBY_INTEGRATION_ENABLED === 'true';
  const secret = typeof source.ASHBY_WEBHOOK_SECRET === 'string' ? source.ASHBY_WEBHOOK_SECRET : '';
  const webhookSecretConfigured =
    secret.length >= MIN_WEBHOOK_SECRET_LENGTH && secret !== SECRET_PLACEHOLDER;
  return { enabled, webhookSecretConfigured, webhookSecret: secret };
}

/**
 * True iff the inbound webhook path is active (enabled AND a usable secret).
 * When false, the route must fail closed without verifying or recording.
 */
export function isAshbyWebhookActive(config: AshbyIntegrationConfig): boolean {
  return config.enabled && config.webhookSecretConfigured;
}

/**
 * Non-sensitive health/metadata view of the integration state. Contains only
 * booleans — never the secret, and it makes no live-connectivity claim.
 */
export function describeAshbyConfig(
  config: AshbyIntegrationConfig,
): { enabled: boolean; webhookSecretConfigured: boolean; active: boolean } {
  return {
    enabled: config.enabled,
    webhookSecretConfigured: config.webhookSecretConfigured,
    active: isAshbyWebhookActive(config),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Runtime activation config (0032 / activation spine)
// ═══════════════════════════════════════════════════════════════════════
//
// The runtime (workers + scheduler + outbound client) is gated by a SECOND,
// INDEPENDENT switch on top of `ASHBY_INTEGRATION_ENABLED`. Both must be true
// AND a usable `ASHBY_API_KEY` must be provisioned before any timer is armed,
// any client is constructed, any DB poll is issued, or any network call is
// made. Deploying this code with the defaults changes nothing about the
// running system — that is the whole point of the second flag.
//
// SECURITY: `apiKey` is carried here solely to hand to the AshbyClient
// constructor. It is NEVER logged, returned by a describe/health view,
// serialized, or placed in an error. `describeAshbyRuntime` emits booleans and
// bounded integers only.

/** Bounds for every runtime tuning value. Inputs are clamped, never trusted. */
export const RUNTIME_BOUNDS = {
  signalPollMs: { def: 5_000, min: 250, max: 300_000 },
  operationPollMs: { def: 5_000, min: 250, max: 300_000 },
  reconcileIntervalMs: { def: 900_000, min: 60_000, max: 86_400_000 },
  reclaimIntervalMs: { def: 60_000, min: 5_000, max: 3_600_000 },
  leaseSeconds: { def: 60, min: 5, max: 900 },
} as const;

/** Maximum number of allowlisted resume hosts accepted from configuration. */
export const MAX_RESUME_HOSTS = 16;

export interface AshbyRuntimeConfig {
  /** Independent runtime switch (`ASHBY_RUNTIME_ENABLED=true`). Default false. */
  runtimeEnabled: boolean;
  /** True iff a non-placeholder API key of sufficient length is provisioned. */
  apiKeyConfigured: boolean;
  /** The raw API key — for the client constructor only; never log or return it. */
  apiKey: string;
  /**
   * Exact, lowercased presigned-resume hosts. EMPTY BY DEFAULT, which keeps
   * `UrlPolicy.allowlistEnabled` false and every resume fetch fail-closed.
   */
  resumeHosts: readonly string[];
  signalPollMs: number;
  operationPollMs: number;
  reconcileIntervalMs: number;
  reclaimIntervalMs: number;
  leaseSeconds: number;
}

/** Clamp a raw env integer into [min,max]; any malformed value yields `def`. */
function boundedMs(raw: string | undefined, bound: { def: number; min: number; max: number }): number {
  if (typeof raw !== 'string' || !/^\d{1,12}$/.test(raw.trim())) return bound.def;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) return bound.def;
  return n < bound.min ? bound.min : n > bound.max ? bound.max : n;
}

/**
 * Parse the exact-host resume allowlist. Suffix matching is deliberately NOT
 * supported: each entry must be a complete lowercased hostname. Anything with
 * a scheme, path, port, wildcard, userinfo, or non-hostname character is
 * dropped rather than coerced, so a malformed entry can never widen the
 * allowlist. An empty result leaves the SSRF policy disabled (fail-closed).
 */
export function parseResumeHosts(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const host = part.trim().toLowerCase();
    if (host === '') continue;
    // Exact hostname only: labels of [a-z0-9-] separated by dots, no leading/
    // trailing hyphen, at least one dot, bounded length. Rejects wildcards,
    // ports, schemes, paths, userinfo, IP literals with brackets, and spaces.
    if (host.length > 253) continue;
    if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
      continue;
    }
    if (!out.includes(host)) out.push(host);
    if (out.length >= MAX_RESUME_HOSTS) break;
  }
  return out;
}

/**
 * Load the runtime activation config from an env map (defaults to process.env).
 * Performs no I/O and no network call. Every numeric value is clamped.
 */
export function loadAshbyRuntimeConfig(
  source: NodeJS.ProcessEnv = process.env,
): AshbyRuntimeConfig {
  const apiKey = typeof source.ASHBY_API_KEY === 'string' ? source.ASHBY_API_KEY : '';
  const apiKeyConfigured = apiKey.length >= MIN_API_KEY_LENGTH && apiKey !== SECRET_PLACEHOLDER;
  return {
    runtimeEnabled: source.ASHBY_RUNTIME_ENABLED === 'true',
    apiKeyConfigured,
    apiKey,
    resumeHosts: parseResumeHosts(source.ASHBY_RESUME_HOSTS),
    signalPollMs: boundedMs(source.ASHBY_SIGNAL_POLL_MS, RUNTIME_BOUNDS.signalPollMs),
    operationPollMs: boundedMs(source.ASHBY_OPERATION_POLL_MS, RUNTIME_BOUNDS.operationPollMs),
    reconcileIntervalMs: boundedMs(source.ASHBY_RECONCILE_INTERVAL_MS, RUNTIME_BOUNDS.reconcileIntervalMs),
    reclaimIntervalMs: boundedMs(source.ASHBY_RECLAIM_INTERVAL_MS, RUNTIME_BOUNDS.reclaimIntervalMs),
    leaseSeconds: boundedMs(source.ASHBY_LEASE_SECONDS, RUNTIME_BOUNDS.leaseSeconds),
  };
}

/**
 * True iff the full outbound runtime may operate: the integration master
 * switch is on, a usable webhook secret exists, the independent runtime flag
 * is on, AND an API key is provisioned. Any false → no client, no timer, no
 * DB poll, no network.
 */
export function isAshbyRuntimeActive(
  config: AshbyIntegrationConfig,
  runtime: AshbyRuntimeConfig,
): boolean {
  return isAshbyWebhookActive(config) && runtime.runtimeEnabled && runtime.apiKeyConfigured;
}

/**
 * Non-sensitive health/metadata view of the runtime state. Booleans and
 * bounded integers ONLY — never the API key, the webhook secret, or a host.
 * `resumeAllowlistEnabled` reports whether any host is configured WITHOUT
 * disclosing which, because the presigned host is tenant-identifying.
 */
export function describeAshbyRuntime(
  config: AshbyIntegrationConfig,
  runtime: AshbyRuntimeConfig,
): {
  runtimeEnabled: boolean;
  apiKeyConfigured: boolean;
  resumeAllowlistEnabled: boolean;
  resumeAllowlistCount: number;
  active: boolean;
  signalPollMs: number;
  operationPollMs: number;
  reconcileIntervalMs: number;
  reclaimIntervalMs: number;
  leaseSeconds: number;
} {
  return {
    runtimeEnabled: runtime.runtimeEnabled,
    apiKeyConfigured: runtime.apiKeyConfigured,
    resumeAllowlistEnabled: runtime.resumeHosts.length > 0,
    resumeAllowlistCount: runtime.resumeHosts.length,
    active: isAshbyRuntimeActive(config, runtime),
    signalPollMs: runtime.signalPollMs,
    operationPollMs: runtime.operationPollMs,
    reconcileIntervalMs: runtime.reconcileIntervalMs,
    reclaimIntervalMs: runtime.reclaimIntervalMs,
    leaseSeconds: runtime.leaseSeconds,
  };
}
