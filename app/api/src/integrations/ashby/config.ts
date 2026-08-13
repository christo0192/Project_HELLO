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
];
void _contractVisibleEnvReads;

/** Minimum accepted webhook secret length (rejects trivially short secrets). */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

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
