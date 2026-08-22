/**
 * livekit-phone-dial/config.ts — TRANSPORT configuration, deliberately not
 * domain configuration.
 *
 * ── WHY THESE KNOBS ARE NOT IN `phone-screening/config.ts` ────────────
 * The domain core carries a structural assertion that NO file under it names
 * SIP, a trunk, a provider or the LiveKit SDK — the property that makes "this
 * package cannot place a call" checkable rather than merely stated. A
 * `sipTrunkId` field would have broken that assertion, and the tempting fix is
 * to relax the pattern.
 *
 * That fix would be wrong. The assertion is not incidentally true; it is the
 * reason the domain core can be reasoned about at all. A trunk id is not a
 * fact about the phone SCREENING DOMAIN (which knows about budgets, windows,
 * consent and state), it is a fact about the TRANSPORT that happens to carry
 * it. Putting it here keeps both statements strong and honest:
 *
 *   * `phone-screening` cannot dial, and a test proves it;
 *   * `livekit-phone-dial` can, and everything about how is in one place.
 *
 * ── THE FOUR GATES ARE STILL SEPARATE ─────────────────────────────────
 * `isLiveDialPermitted` (domain) answers "do the FLAGS and the ALLOWLIST
 * permit a live call". `isPhoneTransportReady` (here) answers "is there
 * anywhere to send one". Both must hold, and neither implies the other — an
 * operator who arms the dialer without configuring a trunk has made one
 * decision, not two.
 *
 * Importing this module performs NO I/O and reads NO ambient state: the loader
 * takes an injectable `source` map.
 */

// Keep the env names visible to `scripts/check-env-contract.mjs`, which scans
// for literal `process.env.<VAR>` reads. The functional reads all go through
// the injectable `source` map below.
const _contractVisibleEnvReads = [
  process.env.PHONE_SIP_TRUNK_ID,
  process.env.PHONE_AGENT_NAME,
  process.env.PHONE_ORIGINATE_TIMEOUT_SECONDS,
  process.env.PHONE_MAX_CALL_SECONDS,
];
void _contractVisibleEnvReads;

/**
 * Bounds for the two time knobs. Both are CLAMPED and neither is fatal: a typo
 * in an operator's environment must not take the API down, and the safe
 * reading of an unparseable billable ceiling is the default, not "unbounded".
 */
export const PHONE_DIAL_BOUNDS = {
  /**
   * How long the ORIGINATE CALL ITSELF may block, in seconds — NOT how long
   * the line may ring, which is `PHONE_RING_TIMEOUT_SECONDS`.
   *
   * Explicit because the SDK default is 60 s when `waitUntilAnswered` is true,
   * which is exactly the default `PHONE_LEASE_SECONDS`. An originate that
   * blocks for the whole lease races `reclaim_phone_attempt_leases`, which
   * would abandon an attempt whose dial is still in flight — and P3's
   * reconciliation sweep deliberately leaves HELD leases alone, so no second
   * observer would catch it. The maximum is kept well under the lease maximum
   * so the dial controller's "lease outlives the originate" check is
   * satisfiable rather than merely asserted.
   */
  originateTimeoutSeconds: { def: 30, min: 5, max: 90 },
  /**
   * Hard ceiling on a CONNECTED call, in seconds. Never left to the provider
   * default: an unset billable ceiling is not a default, it is an omission,
   * and a stuck leg would hold a fleet slot until something else noticed.
   */
  maxCallSeconds: { def: 900, min: 60, max: 3_600 },
} as const;

export interface PhoneDialConfig {
  /**
   * PROVIDER-NEUTRAL outbound trunk identifier, opaque to this codebase.
   * EMPTY BY DEFAULT, and empty is FAIL-CLOSED: no trunk, no originate.
   */
  sipTrunkId: string;
  /**
   * Name of the SEPARATE, named phone worker, if one is deployed. EMPTY means
   * the phone room dispatches NOBODY — a legitimate state, not an error.
   *
   * The existing browser worker stays UNNAMED and auto-dispatching on purpose.
   * Naming it would stop it auto-dispatching into every existing browser room
   * and would break browser screening in the window between an API deploy and
   * a worker deploy. Rollback here is "do not deploy the named phone worker",
   * which needs no Python change at all.
   */
  agentName: string;
  originateTimeoutSeconds: number;
  maxCallSeconds: number;
}

/**
 * An opaque provider identifier: a bounded run of characters that CANNOT
 * express a phone number. `+` and space are outside the class deliberately, so
 * this field can never be talked into holding an E.164 value, and the length
 * bound stops an unbounded string reaching a provider call. Anything that does
 * not match is DROPPED to empty, which is fail-closed.
 */
function boundedOpaqueId(raw: string | undefined, maxLength: number): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return new RegExp(`^[A-Za-z0-9_-]{1,${maxLength}}$`).test(value) ? value : '';
}

/** Clamp a raw env integer into [min,max]; any malformed value yields `def`. */
function boundedInt(
  raw: string | undefined,
  bound: { def: number; min: number; max: number },
): number {
  if (typeof raw !== 'string' || !/^\d{1,12}$/.test(raw.trim())) return bound.def;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) return bound.def;
  return n < bound.min ? bound.min : n > bound.max ? bound.max : n;
}

export function loadPhoneDialConfig(
  source: NodeJS.ProcessEnv = process.env,
): PhoneDialConfig {
  return {
    sipTrunkId: boundedOpaqueId(source.PHONE_SIP_TRUNK_ID, 128),
    agentName: boundedOpaqueId(source.PHONE_AGENT_NAME, 64),
    originateTimeoutSeconds: boundedInt(
      source.PHONE_ORIGINATE_TIMEOUT_SECONDS,
      PHONE_DIAL_BOUNDS.originateTimeoutSeconds,
    ),
    maxCallSeconds: boundedInt(source.PHONE_MAX_CALL_SECONDS, PHONE_DIAL_BOUNDS.maxCallSeconds),
  };
}

/**
 * True iff there is somewhere to send a call. Independent of every domain
 * flag: an armed dialer with no trunk is misconfigured, not permitted.
 */
export function isPhoneTransportReady(config: PhoneDialConfig): boolean {
  return config.sipTrunkId !== '';
}

/**
 * Non-sensitive health view. Booleans and bounded integers only — never the
 * trunk id and never the agent name, both of which are deployment identifiers
 * that a health surface has no reason to publish.
 */
export function describePhoneDialConfig(config: PhoneDialConfig): {
  sipTrunkConfigured: boolean;
  phoneAgentConfigured: boolean;
  originateTimeoutSeconds: number;
  maxCallSeconds: number;
} {
  return {
    sipTrunkConfigured: isPhoneTransportReady(config),
    phoneAgentConfigured: config.agentName !== '',
    originateTimeoutSeconds: config.originateTimeoutSeconds,
    maxCallSeconds: config.maxCallSeconds,
  };
}
