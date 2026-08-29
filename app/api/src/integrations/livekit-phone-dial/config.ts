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
  process.env.PHONE_BOUNCE_MODE,
  process.env.PHONE_BOUNCE_TRUNK_ID,
  process.env.PHONE_BOUNCE_SIP_USER,
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
   * Explicit because the SDK default is 60 s when `waitUntilAnswered` is true.
   * That was once exactly the default `PHONE_LEASE_SECONDS`, and is now well
   * inside it (180 s) — but the hazard is the dependency, not the arithmetic:
   * a bound that gates a fleet slot must not be left to a provider SDK's
   * default, which can change under us. An originate that
   * blocks for the whole lease races `reclaim_phone_attempt_leases`, which
   * would abandon an attempt whose dial is still in flight — and P3's
   * reconciliation sweep deliberately leaves HELD leases alone, so no second
   * observer would catch it. The maximum is kept well under the lease maximum
   * so the dial controller's "lease outlives the originate" check is
   * satisfiable rather than merely asserted.
   *
   * The DEFAULT is 60 s, which must stay STRICTLY GREATER than the default
   * `PHONE_RING_TIMEOUT_SECONDS` (45 s). If the originate gives up while the
   * carrier is still ringing, the controller writes the dial off as
   * `originate_failed` — and the leg can still be answered afterwards, landing
   * a real person in a room whose dial we have abandoned. `dial.ts` refuses
   * before the SDK rather than trusting these defaults to stay ordered.
   */
  originateTimeoutSeconds: { def: 60, min: 5, max: 90 },
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
   * a worker deploy. Since the §6 canary flip the named phone worker IS
   * deployed always-on and this value is non-empty in production; rollback is
   * the §5 pair — revert the posture PR AND scale the phone app to zero
   * (docs/runbooks/phone-worker-deployment.md §5) — no Python change needed.
   */
  agentName: string;
  originateTimeoutSeconds: number;
  maxCallSeconds: number;
  /**
   * ── ANSWER-FIRST ORIGINATION ("bounce mode"), default OFF ─────────────
   * When true, LiveKit no longer dials the candidate directly. It dials a
   * Plivo VOICE-APP SIP ENDPOINT that answers INSTANTLY — so LiveKit sees an
   * answered call in ~1 s and its (unfixable) outbound-SIP answer-detection
   * timers are satisfied forever — and Plivo's application then dials the
   * candidate and bridges. The candidate number still passes EVERY existing
   * admission/allowlist gate exactly as today; it simply is not what LiveKit
   * dials. See `PHONE_BOUNCE_MODE`'s comment in `.env.example` and
   * `routes/plivo-webhook.ts`.
   *
   * OFF is byte-identical to the pre-bounce behaviour: the three fields below
   * are unread and the dialer targets `sipTrunkId` with the candidate number
   * exactly as before.
   */
  bounceMode: boolean;
  /**
   * The BOUNCE trunk id — the LiveKit outbound trunk pointing at Plivo's voice
   * app SIP domain. Opaque, EMPTY BY DEFAULT, and empty is FAIL-CLOSED WHEN
   * BOUNCE IS ON: `isPhoneTransportReady` refuses a bounce dial with no bounce
   * trunk, so an operator who turns bounce on without provisioning it gets a
   * refusal, not a dial down the wrong trunk.
   */
  bounceTrunkId: string;
  /**
   * The Plivo ENDPOINT USERNAME LiveKit dials in bounce mode (e.g.
   * `hello_bounce`). A bounded opaque identifier — it can never hold a phone
   * number (the class excludes `+` and space), so a misconfiguration cannot
   * turn this field into a candidate number reaching a carrier. EMPTY is
   * fail-closed when bounce is on.
   */
  bounceSipUser: string;
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
    // The SAME `=== 'true'` idiom the domain master switch uses: anything but
    // the exact string `true` is OFF, which is fail-closed for a flag that
    // reroutes every dial.
    bounceMode: source.PHONE_BOUNCE_MODE === 'true',
    // The bounce trunk is a provider trunk id, the same class as `sipTrunkId`.
    bounceTrunkId: boundedOpaqueId(source.PHONE_BOUNCE_TRUNK_ID, 128),
    // A short endpoint username. 64 is generous for a SIP user and keeps the
    // bound well under anything a provider would accept, so a runaway value is
    // dropped to empty (fail-closed) rather than sent.
    bounceSipUser: boundedOpaqueId(source.PHONE_BOUNCE_SIP_USER, 64),
  };
}

/**
 * True iff there is somewhere to send a call. Independent of every domain
 * flag: an armed dialer with no trunk is misconfigured, not permitted.
 *
 * ── BOUNCE MODE HAS ITS OWN "SOMEWHERE TO SEND IT" ────────────────────
 * When bounce is on, the direct `sipTrunkId` is NOT what a dial targets — the
 * BOUNCE trunk and the BOUNCE endpoint user are. So readiness in bounce mode
 * requires BOTH of those, and does NOT require `sipTrunkId`: an operator who
 * has provisioned the bounce path but retired the direct trunk is correctly
 * configured, and the reverse (bounce on, bounce path absent) is fail-closed
 * here rather than at the SDK. Off, the check is exactly as it always was.
 */
export function isPhoneTransportReady(config: PhoneDialConfig): boolean {
  if (config.bounceMode) {
    return config.bounceTrunkId !== '' && config.bounceSipUser !== '';
  }
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
  bounceMode: boolean;
  bounceConfigured: boolean;
} {
  return {
    sipTrunkConfigured: isPhoneTransportReady(config),
    phoneAgentConfigured: config.agentName !== '',
    originateTimeoutSeconds: config.originateTimeoutSeconds,
    maxCallSeconds: config.maxCallSeconds,
    // Booleans only — never the bounce trunk id and never the endpoint user,
    // both deployment identifiers a health surface has no reason to publish.
    bounceMode: config.bounceMode,
    bounceConfigured: config.bounceTrunkId !== '' && config.bounceSipUser !== '',
  };
}
