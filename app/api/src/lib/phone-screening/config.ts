/**
 * phone-screening/config.ts — the disabled-by-default configuration spine.
 *
 * ── TWO INDEPENDENT SWITCHES, BOTH OFF ────────────────────────────────
 * `PHONE_SCREENING_ENABLED` is the MASTER switch for the phone domain;
 * `PHONE_RUNTIME_ENABLED` independently arms the workers and timers a later
 * phase will own. Neither implies the other, and both default to `false`, so
 * deploying this module changes nothing about the running system. That is the
 * whole point of the second flag — it mirrors the Ashby
 * `ASHBY_INTEGRATION_ENABLED` / `ASHBY_RUNTIME_ENABLED` spine.
 *
 * `PHONE_DIAL_MODE` is a THIRD, orthogonal gate: `off` (default) places no
 * call at all, `synthetic` exercises the path against a local fake, and `live`
 * is the only value that could ever reach a carrier — and even then only once
 * a later phase supplies a transport, which this module does not.
 *
 * ── THE ALLOWLIST HOLDS DIGESTS, NEVER NUMBERS ────────────────────────
 * `PHONE_DIAL_ALLOWLIST` is a comma-separated list of SHA-256 hex DIGESTS of
 * permitted E.164 numbers, the same shape `phone_suppressions.phone_sha256`
 * uses. A raw number in configuration would be a phone value living in a
 * process environment, an error message and every crash dump — the property
 * this whole lane maintains is that no raw number exists anywhere outside the
 * `candidates` row and the digest computed from it. EMPTY BY DEFAULT, and an
 * empty allowlist is FAIL-CLOSED: nothing is dialable.
 *
 * ── NO FLEET DAILY CAP HERE ───────────────────────────────────────────
 * There is deliberately no fleet-wide daily-dial knob. 0042 has no fleet-wide
 * daily control at all — `uq_phone_attempts_one_per_ist_day` is
 * PER-ENGAGEMENT — so shipping one now would hand an operator a dial that
 * changes nothing until a later phase enforces it. A value with no consumer is
 * a decoration, and this lane has already paid for that lesson. A structural
 * assertion keeps the name out of this file, the schema and the example.
 *
 * ── THE WINDOW AND THE FLEET CAP ARE NOT CONFIGURED HERE ──────────────
 * The IST calling window and the fleet concurrency cap live in
 * `screening_v2.phone_ist_window_open_at()`, `phone_ist_window_close_at()` and
 * `phone_max_concurrent()`, and are MIRRORED (never re-declared) in
 * `ist-window.ts`. A second definition in configuration is exactly the drift
 * 0042 was shaped to prevent: it would be silent in TypeScript and enforced in
 * SQL. Narrowing is available through `narrowIstWindow`, which refuses to
 * widen. No bound of either appears anywhere in this file, and a structural
 * assertion enforces that.
 *
 * Importing this module performs NO I/O, opens NO connection, arms NO timer
 * and reads NO ambient state: every loader takes an injectable `source` map.
 */

// Keep the env names visible to `scripts/check-env-contract.mjs`, which scans
// for literal `process.env.<VAR>` reads. The functional reads all go through
// the injectable `source` map below.
const _contractVisibleEnvReads = [
  process.env.PHONE_SCREENING_ENABLED,
  process.env.PHONE_RUNTIME_ENABLED,
  process.env.PHONE_DIAL_MODE,
  process.env.PHONE_DIAL_ALLOWLIST,
  process.env.PHONE_SLOT_SECONDS,
  process.env.PHONE_RECONNECT_BACKOFF_SECONDS,
  process.env.PHONE_INFRA_DEFER_BACKOFF_SEC,
  process.env.PHONE_RING_TIMEOUT_SECONDS,
  process.env.PHONE_LEASE_SECONDS,
  process.env.PHONE_WEBHOOK_MAX_BYTES,
  process.env.PHONE_WEBHOOK_TOLERANCE_SECONDS,
];
void _contractVisibleEnvReads;

/** The three dial modes. `off` is the default and places no call. */
export const PHONE_DIAL_MODES = ['off', 'synthetic', 'live'] as const;

export type PhoneDialMode = (typeof PHONE_DIAL_MODES)[number];

/**
 * Bounds for every numeric knob. Inputs are CLAMPED, never trusted and never
 * fatal: a malformed value falls back to the default rather than throwing at
 * import, so a typo in an operator's environment cannot take the API down.
 */
/**
 * How long the OPENING GATE may take, from the moment somebody answers to the
 * moment the agent's first heartbeat lands.
 *
 * It covers `classify.human`, the spoken disclosure, the candidate's answer,
 * the `disclosure.delivered` post and the AWAITED LiveKit egress call inside
 * that same request. It is an allowance, not a measurement: nothing enforces
 * it on the agent, and its only job here is to size the lease so the gate
 * cannot outlive the slot it is holding.
 *
 * Sixty seconds is deliberately generous. The cost of being too generous is a
 * fleet slot held slightly longer than necessary; the cost of being too mean
 * is hanging up on a candidate who has just consented.
 */
export const PHONE_OPENING_GATE_SECONDS = 60;

export const PHONE_BOUNDS = {
  /**
   * Default internal-appointment slot length. Bounded by
   * `chk_phone_appointments_duration` (900..3600 s); a value outside that
   * envelope would be refused by the trigger at booking time, so it is
   * refused here instead.
   */
  slotSeconds: { def: 1_800, min: 900, max: 3_600 },
  /**
   * Reconnect backoff. 120 s is the design default and the reason the window
   * is re-evaluated when the reconnect is ACTED ON: a backoff decided at
   * 20:59 lands at 21:01, outside the window.
   */
  reconnectBackoffSeconds: { def: 120, min: 5, max: 3_600 },
  /**
   * 0083 / P3. How long `abandon_phone_attempt_infra` pushes an engagement's
   * `next_eligible_at` forward after a pre-originate infra defer
   * (`worker_not_ready`). Bounds a persistently-broken pool (empty pool / flag
   * off / boot slower than the ready timeout) to ONE infra-defer per window
   * instead of one per due tick: without it the restored engagement would be
   * immediately due again and churn admit -> start -> wait -> stop -> abandon on
   * every pass. 300s default; clamped [60,3600] here AND again in SQL (the RPC
   * is service-role callable directly and must not trust its input).
   */
  infraDeferBackoffSeconds: { def: 300, min: 60, max: 3_600 },
  /** How long an unanswered outbound leg may ring before it is a no-answer. */
  ringTimeoutSeconds: { def: 45, min: 5, max: 120 },
  /**
   * Concurrency-lease length handed to `admit_phone_attempt` /
   * `heartbeat_phone_attempt`. Those RPCs clamp independently to [5, 900];
   * these bounds stay inside that range so the two never disagree.
   *
   * ── WHY THE DEFAULT IS 180 AND NOT 60 ────────────────────────────
   * The lease has to cover the whole stretch during which NOBODY IS
   * HEARTBEATING YET, and that stretch is longer than it looks:
   *
   *   originate begins ─ lease is extended once, pre-originate, to
   *                      max(originateTimeoutSeconds + LEASE_MARGIN, lease)
   *   the line rings ─── up to `ringTimeoutSeconds` (45 by default, 120 max)
   *   somebody answers ─ and only now does the opening gate start
   *   the gate runs ──── classify.human, the spoken disclosure, the
   *                      candidate's answer, the `disclosure.delivered` post,
   *                      and an AWAITED LiveKit egress call inside that same
   *                      request
   *   the agent beats ── first heartbeat, at last
   *
   * At 60 the pre-originate lease was max(75, 60) = 75s from the START of
   * the originate, so a candidate answering on the last ring left roughly
   * THIRTY SECONDS for a gate that spends part of it waiting on a provider.
   * A gate that overran met an already-lapsed lease, the first beat answered
   * `lease_lost`, and the agent hung up seconds after the candidate had
   * consented — and because the engagement is `in_call` by then, the room
   * close charged a reconnect and the next leg carried the same risk.
   *
   * 180 covers `ringTimeoutSeconds` at its maximum plus a full
   * `PHONE_OPENING_GATE_SECONDS`, and still leaves the published heartbeat
   * cadence (a third of the lease, 60s) comfortably under half of it.
   *
   * The relation is ENFORCED, not merely defaulted — see
   * `lease_too_short_for_gate` in `dialPhoneAttempt`. This PR has twice
   * shipped a bound that lived only in a paragraph, and twice had it missed.
   */
  leaseSeconds: { def: 180, min: 5, max: 900 },
  /** Largest ingress webhook body accepted before it is refused unread. */
  webhookMaxBytes: { def: 65_536, min: 1_024, max: 1_048_576 },
  /** Replay tolerance on a signed ingress timestamp. */
  webhookToleranceSeconds: { def: 300, min: 30, max: 3_600 },
} as const;

/** Maximum allowlist entries accepted from configuration. */
export const MAX_DIAL_ALLOWLIST_ENTRIES = 64;

/** A SHA-256 digest in lowercase hex — the only form the allowlist accepts. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface PhoneScreeningConfig {
  /** Master switch (`PHONE_SCREENING_ENABLED=true`). Default false. */
  screeningEnabled: boolean;
  /** Independent runtime switch (`PHONE_RUNTIME_ENABLED=true`). Default false. */
  runtimeEnabled: boolean;
  /** `off` | `synthetic` | `live`. Default `off`; an unknown value reads as `off`. */
  dialMode: PhoneDialMode;
  /** Lowercased SHA-256 digests of permitted numbers. EMPTY = nothing dialable. */
  dialAllowlist: readonly string[];
  slotSeconds: number;
  reconnectBackoffSeconds: number;
  /** 0083/P3: backoff (s) applied to next_eligible_at on a worker-not-ready infra defer. */
  infraDeferBackoffSeconds: number;
  ringTimeoutSeconds: number;
  leaseSeconds: number;
  webhookMaxBytes: number;
  webhookToleranceSeconds: number;
}

/** Clamp a raw env integer into [min,max]; any malformed value yields `def`. */
function boundedInt(
  raw: string | undefined,
  bound: { def: number; min: number; max: number },
): number {
  if (typeof raw !== 'string' || !/^\d{1,12}$/.test(raw.trim())) return bound.def;
  const n = Number(raw.trim());
  // Unreachable while the pattern above caps the input at twelve digits, and
  // kept deliberately: it is the guard that stays correct if that cap is ever
  // widened, and it matches the house helper in `integrations/ashby/config.ts`
  // rather than quietly diverging from it.
  if (!Number.isSafeInteger(n)) return bound.def;
  return n < bound.min ? bound.min : n > bound.max ? bound.max : n;
}

/**
 * Resolve the dial mode. An UNRECOGNISED value reads as `off` rather than
 * throwing: the safe reading of a typo on a billable dialer is "do not dial".
 */
export function parseDialMode(raw: string | undefined): PhoneDialMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (PHONE_DIAL_MODES as readonly string[]).includes(value)
    ? (value as PhoneDialMode)
    : 'off';
}

/**
 * Parse the digest allowlist. Each entry must be a complete lowercase SHA-256
 * hex digest; anything else — a raw number, a partial digest, an uppercase
 * variant, whitespace-mangled input — is DROPPED rather than coerced, so a
 * malformed entry can never widen the allowlist. An empty result leaves the
 * allowlist disabled, which is fail-closed.
 */
export function parseDialAllowlist(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase();
    if (entry === '' || !SHA256_HEX.test(entry)) continue;
    if (!out.includes(entry)) out.push(entry);
    if (out.length >= MAX_DIAL_ALLOWLIST_ENTRIES) break;
  }
  return out;
}

/**
 * Load the phone-screening config from an env map (defaults to `process.env`).
 * Performs no I/O and no network call. Every numeric value is clamped and no
 * value is fatal.
 */
export function loadPhoneScreeningConfig(
  source: NodeJS.ProcessEnv = process.env,
): PhoneScreeningConfig {
  return {
    screeningEnabled: source.PHONE_SCREENING_ENABLED === 'true',
    runtimeEnabled: source.PHONE_RUNTIME_ENABLED === 'true',
    dialMode: parseDialMode(source.PHONE_DIAL_MODE),
    dialAllowlist: parseDialAllowlist(source.PHONE_DIAL_ALLOWLIST),
    slotSeconds: boundedInt(source.PHONE_SLOT_SECONDS, PHONE_BOUNDS.slotSeconds),
    reconnectBackoffSeconds: boundedInt(
      source.PHONE_RECONNECT_BACKOFF_SECONDS,
      PHONE_BOUNDS.reconnectBackoffSeconds,
    ),
    infraDeferBackoffSeconds: boundedInt(
      source.PHONE_INFRA_DEFER_BACKOFF_SEC,
      PHONE_BOUNDS.infraDeferBackoffSeconds,
    ),
    ringTimeoutSeconds: boundedInt(
      source.PHONE_RING_TIMEOUT_SECONDS,
      PHONE_BOUNDS.ringTimeoutSeconds,
    ),
    leaseSeconds: boundedInt(source.PHONE_LEASE_SECONDS, PHONE_BOUNDS.leaseSeconds),
    webhookMaxBytes: boundedInt(source.PHONE_WEBHOOK_MAX_BYTES, PHONE_BOUNDS.webhookMaxBytes),
    webhookToleranceSeconds: boundedInt(
      source.PHONE_WEBHOOK_TOLERANCE_SECONDS,
      PHONE_BOUNDS.webhookToleranceSeconds,
    ),
  };
}

/**
 * True iff the domain is active AT ALL. Both switches must be on; either one
 * off means no worker is armed and no admission is attempted.
 */
export function isPhoneRuntimeActive(config: PhoneScreeningConfig): boolean {
  return config.screeningEnabled && config.runtimeEnabled;
}

/**
 * True iff a call could reach a real carrier: the runtime is active, the mode
 * is `live`, and the allowlist is non-empty. An empty allowlist FAILS CLOSED
 * even in `live` mode — the enable and the target list are two decisions, and
 * neither is allowed to imply the other.
 */
export function isLiveDialPermitted(config: PhoneScreeningConfig): boolean {
  return isPhoneRuntimeActive(config) && config.dialMode === 'live'
    && config.dialAllowlist.length > 0;
}

/**
 * True iff this digest may be dialled under the current configuration. Takes a
 * DIGEST, never a number, so no caller is tempted to pass one.
 */
export function isDialAllowedForDigest(config: PhoneScreeningConfig, digest: string): boolean {
  if (!isLiveDialPermitted(config)) return false;
  return config.dialAllowlist.includes(digest.trim().toLowerCase());
}

/**
 * Non-sensitive health/metadata view. Booleans and bounded integers only, and
 * the allowlist is reported as a COUNT — never its contents, because a digest
 * set is still a set of identifiers about specific people.
 */
export function describePhoneScreeningConfig(config: PhoneScreeningConfig): {
  screeningEnabled: boolean;
  runtimeEnabled: boolean;
  runtimeActive: boolean;
  dialMode: PhoneDialMode;
  dialAllowlistSize: number;
  liveDialPermitted: boolean;
} {
  return {
    screeningEnabled: config.screeningEnabled,
    runtimeEnabled: config.runtimeEnabled,
    runtimeActive: isPhoneRuntimeActive(config),
    dialMode: config.dialMode,
    dialAllowlistSize: config.dialAllowlist.length,
    liveDialPermitted: isLiveDialPermitted(config),
  };
}
