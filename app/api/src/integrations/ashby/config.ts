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
  process.env.ASHBY_SCANNER_DEFER_SECONDS,
  process.env.ASHBY_SCANNER_READINESS_TIMEOUT_MS,
  process.env.ASHBY_SCANNER_DEFER_DEADLINE_MS,
  // Reconciliation sweep tuning (0034). A backfill against a large corpus has
  // to be tunable WITHOUT a deploy: production measured ~119k applications
  // paging ~100/request regardless of the requested limit, which is 24 runs at
  // the default bounds.
  process.env.ASHBY_RECONCILE_SWEEP_INTERVAL_MS,
  process.env.ASHBY_RECONCILE_MAX_PAGES,
  process.env.ASHBY_RECONCILE_MAX_ITEMS,
  process.env.ASHBY_RECONCILE_PAGE_LIMIT,
  process.env.ASHBY_RECONCILE_DEADLINE_MS,
  process.env.ASHBY_RECONCILE_MAX_ENQUEUE,
  process.env.ASHBY_RECONCILE_ANCHOR_DISABLED,
  process.env.ASHBY_RECONCILE_SWEEP_MAX_ENQUEUE,
  process.env.ASHBY_RECONCILE_SWEEP_MAX_PAGES,
  process.env.ASHBY_RECONCILE_SWEEP_MAX_RESTARTS,
  process.env.ASHBY_RECONCILE_ANCHOR_MAX_AGE_MS,
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
  /**
   * How long an ingestion job waits after finding the malware scanner not
   * ready (0037 deferral). The queue clamps to [1, 3600] independently; these
   * bounds keep the tunable inside the range where a cold boot is picked up
   * promptly without hot-looping. A deferral refunds its attempt, so this
   * knob trades poll frequency against pickup latency and nothing else.
   */
  scannerDeferSeconds: { def: 45, min: 5, max: 600 },
  /**
   * Bound on the worker-side scanner readiness read.
   *
   * The DEFAULT (2s) sits well inside even the smallest lease (5s), so the
   * gate cannot cost a job its claim. The MAXIMUM deliberately exceeds that
   * lease: the gate's dominant caller is the PRE-claim admission check, which
   * holds no lease at all, and on the post-claim path an unanswered read
   * DEFERS rather than blocking — so raising this trades pickup latency, not
   * lease safety. Read as: the bound is generous, the default is safe.
   */
  scannerReadinessTimeoutMs: { def: 2_000, min: 250, max: 15_000 },
  /**
   * Wall-clock bound on how long ONE ingestion job may keep deferring on the
   * scanner before the outcome becomes a real, loud `failed_review`. Eight
   * hours is far outside any cold start and far inside the 24-hour signature
   * freshness ceiling, so it can only fire on a genuinely broken updater.
   * It is measured from the job's own creation, so it resets per enqueue and
   * needs no counter with a reset lifecycle.
   */
  scannerDeferDeadlineMs: { def: 28_800_000, min: 300_000, max: 86_400_000 },
  /**
   * Cadence used INSTEAD of `reconcileIntervalMs` while a page-anchored sweep
   * is in flight (0034). Two payoffs: the anchor stays seconds old rather than
   * minutes, which is what makes resume viable if provider cursors are
   * short-lived; and a multi-run backfill drains in minutes instead of hours.
   * Safe at a short interval because the single-flight lease makes an
   * overlapping tick return `locked` before any provider call.
   */
  reconcileSweepIntervalMs: { def: 10_000, min: 1_000, max: 60_000 },
  /** Pages one reconciliation RUN may fetch. */
  reconcileMaxPages: { def: 50, min: 1, max: 1_000 },
  /** Applications one reconciliation RUN may observe. */
  reconcileMaxItems: { def: 5_000, min: 1, max: 100_000 },
  /**
   * Page-size hint. Production evidence: the provider returned ~100 per page
   * regardless of a requested 500, so treat this as a hint, never a guarantee.
   */
  reconcilePageLimit: { def: 100, min: 1, max: 500 },
  /** Wall-clock budget for one reconciliation run. */
  reconcileDeadlineMs: { def: 60_000, min: 1_000, max: 1_800_000 },
  /** Circuit breaker: signal jobs one run may create. */
  reconcileMaxEnqueue: { def: 200, min: 1, max: 2_000 },
  /**
   * ABSOLUTE ceiling on the jobs one SWEEP may create across all its runs, and
   * the compensating control for page-aligning the per-run breaker (which
   * turned it from a wedge into a rate). Exhausting it HALTS the stream.
   * Conservative by design: the incident this subsystem exists to prevent
   * created 2,000 jobs, so the default would have caught it.
   */
  reconcileSweepMaxEnqueue: { def: 2_000, min: 1, max: 100_000 },
  /** Pages one SWEEP may consume across its runs (~500k applications). */
  reconcileSweepMaxPages: { def: 5_000, min: 1, max: 100_000 },
  /** Sweep restarts allowed before halting — a resume that never holds. */
  reconcileSweepMaxRestarts: { def: 5, min: 1, max: 1_000 },
  /** Age at which a persisted page anchor is discarded (6 h). */
  reconcileAnchorMaxAgeMs: { def: 21_600_000, min: 60_000, max: 604_800_000 },
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
  /** Delay applied when an ingestion defers on scanner readiness (0037). */
  scannerDeferSeconds: number;
  /** Bound on the worker-side scanner readiness read (ms). */
  scannerReadinessTimeoutMs: number;
  /** Wall-clock bound on one job's total scanner deferral (ms). */
  scannerDeferDeadlineMs: number;
  /** Short cadence used while a page-anchored sweep is in flight (0034). */
  reconcileSweepIntervalMs: number;
  /** Per-run reconciliation bounds, tunable without a deploy (0034). */
  reconcileCaps: {
    maxPages: number;
    maxItems: number;
    pageLimit: number;
    deadlineMs: number;
    maxEnqueuePerRun: number;
    /** Sweep-level bounds: the two that decide whether a large tenant finishes. */
    sweepMaxEnqueue: number;
    sweepMaxPages: number;
    sweepMaxRestarts: number;
    anchorMaxAgeMs: number;
  };
  /**
   * KILL SWITCH (`ASHBY_RECONCILE_ANCHOR_DISABLED=true`): skip every anchor
   * read and write, reverting exactly to the pre-0034 all-or-nothing sweep.
   * Safe by construction — not advancing is the conservative failure.
   */
  reconcileAnchorDisabled: boolean;
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
    scannerDeferSeconds: boundedMs(
      source.ASHBY_SCANNER_DEFER_SECONDS, RUNTIME_BOUNDS.scannerDeferSeconds,
    ),
    scannerReadinessTimeoutMs: boundedMs(
      source.ASHBY_SCANNER_READINESS_TIMEOUT_MS, RUNTIME_BOUNDS.scannerReadinessTimeoutMs,
    ),
    scannerDeferDeadlineMs: boundedMs(
      source.ASHBY_SCANNER_DEFER_DEADLINE_MS, RUNTIME_BOUNDS.scannerDeferDeadlineMs,
    ),
    reconcileSweepIntervalMs: boundedMs(
      source.ASHBY_RECONCILE_SWEEP_INTERVAL_MS, RUNTIME_BOUNDS.reconcileSweepIntervalMs,
    ),
    reconcileCaps: {
      maxPages: boundedMs(source.ASHBY_RECONCILE_MAX_PAGES, RUNTIME_BOUNDS.reconcileMaxPages),
      maxItems: boundedMs(source.ASHBY_RECONCILE_MAX_ITEMS, RUNTIME_BOUNDS.reconcileMaxItems),
      pageLimit: boundedMs(source.ASHBY_RECONCILE_PAGE_LIMIT, RUNTIME_BOUNDS.reconcilePageLimit),
      deadlineMs: boundedMs(source.ASHBY_RECONCILE_DEADLINE_MS, RUNTIME_BOUNDS.reconcileDeadlineMs),
      maxEnqueuePerRun: boundedMs(
        source.ASHBY_RECONCILE_MAX_ENQUEUE, RUNTIME_BOUNDS.reconcileMaxEnqueue,
      ),
      sweepMaxEnqueue: boundedMs(
        source.ASHBY_RECONCILE_SWEEP_MAX_ENQUEUE, RUNTIME_BOUNDS.reconcileSweepMaxEnqueue,
      ),
      sweepMaxPages: boundedMs(
        source.ASHBY_RECONCILE_SWEEP_MAX_PAGES, RUNTIME_BOUNDS.reconcileSweepMaxPages,
      ),
      sweepMaxRestarts: boundedMs(
        source.ASHBY_RECONCILE_SWEEP_MAX_RESTARTS, RUNTIME_BOUNDS.reconcileSweepMaxRestarts,
      ),
      anchorMaxAgeMs: boundedMs(
        source.ASHBY_RECONCILE_ANCHOR_MAX_AGE_MS, RUNTIME_BOUNDS.reconcileAnchorMaxAgeMs,
      ),
    },
    reconcileAnchorDisabled: source.ASHBY_RECONCILE_ANCHOR_DISABLED === 'true',
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
 * Read-only provider discovery may run independently of the workflow runtime.
 * It requires the integration/webhook gate and API-key presence, but not the
 * scheduler/runtime flag. This permits an admin to inspect a form schema while
 * imports, reconciliation, invitations, and write-back remain disabled.
 */
export function isAshbyReadOnlyProbeActive(
  config: AshbyIntegrationConfig,
  runtime: AshbyRuntimeConfig,
): boolean {
  return isAshbyWebhookActive(config) && runtime.apiKeyConfigured;
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
  scannerDeferSeconds: number;
  scannerReadinessTimeoutMs: number;
  scannerDeferDeadlineMs: number;
  reconcileSweepIntervalMs: number;
  reconcileAnchorDisabled: boolean;
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
    // All three scanner knobs, not one of three: a tunable an operator cannot
    // read back from /health is a tunable they have to guess at while
    // diagnosing the exact outage it governs.
    scannerDeferSeconds: runtime.scannerDeferSeconds,
    scannerReadinessTimeoutMs: runtime.scannerReadinessTimeoutMs,
    scannerDeferDeadlineMs: runtime.scannerDeferDeadlineMs,
    reconcileSweepIntervalMs: runtime.reconcileSweepIntervalMs,
    reconcileAnchorDisabled: runtime.reconcileAnchorDisabled,
  };
}
