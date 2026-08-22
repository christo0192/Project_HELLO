/**
 * phone-screening/admission.ts — the domain facade.
 *
 * ── THE ONE RULE ──────────────────────────────────────────────────────
 * NOTHING here writes. Every durable effect goes through `PhoneStores`, whose
 * only capability is calling a 0042 RPC. The local gates below can refuse and
 * can defer; they can never admit. `admit_phone_attempt` is the sole grantor,
 * and when a local gate and the database disagree, THE DATABASE'S ANSWER IS
 * THE ONE THAT REACHES THE CALLER.
 *
 * ── DEFER IS NOT AN OUTCOME ───────────────────────────────────────────
 * A pre-claim refusal — the flags are off, the runtime is cold, the digest is
 * not allowlisted, the consent preflight objected — means NO CALL WAS PLACED.
 * It is not an `outcome_class`, it charges no budget, and it writes nothing.
 * Modelling cold start as an outcome would put a twelfth member in a CHECK
 * closed to eleven, and would make a wait look like a failure.
 *
 * ── ADMISSION CHARGES NOTHING, EVER ───────────────────────────────────
 * Window, capacity, consent, suppression, halt, budget and per-day refusals
 * are all free. Budgets move at outcome classification and nowhere else — see
 * `budget.ts`.
 *
 * SECURITY: this module handles engagement ids, attempt ids, lease tokens and
 * digests. It never accepts, derives, stores, returns or logs a phone number.
 */

import { isDialAllowedForDigest, type PhoneScreeningConfig } from './config.js';
import { consentPreflight, type ConsentPreflightRefusal, type ConsentReader } from './consent.js';
import {
  istWindowOpen,
  narrowIstWindow,
  nextIstWindowOpen,
  type IstWindowBounds,
} from './ist-window.js';
import type { AdmitPhoneAttemptResult, PhoneStores } from './ports.js';
import type { AdmitPhoneAttemptStatus } from './rpc-contract.js';
import { PHONE_RPC_UNKNOWN_STATUS } from './rpc-contract.js';
import type { PhoneAttemptKind } from './vocabulary.js';

/**
 * Pre-claim deferral codes. Every member matches the sanitized-reason shape
 * `^[a-z0-9_.:-]{1,64}$` the durable columns accept, so any of these can be
 * recorded as a `state_reason` by a later phase without transformation.
 *
 * `cold_start` is the one this contract calls out by name: a runtime that is
 * not yet ready has placed no call, so it defers. It is NOT `provider_error`,
 * which would charge the provider budget for our own boot time.
 */
export const PHONE_DEFERRAL_CODES = [
  'cold_start',
  'screening_disabled',
  'runtime_disabled',
  'dial_mode_off',
  'dial_not_allowlisted',
  // Deliberately NOT `window_closed`: that is a member of the eleven closed
  // `outcome_class` values, and a deferral is not a call. Keeping the two
  // vocabularies disjoint is what lets a structural test prove that no
  // deferral code can ever be written into `outcome_class`. It corresponds to
  // `admit_phone_attempt`'s `window_closed` refusal, which is a DB verdict.
  'window_closed_defer',
  'consent_preflight_refused',
] as const;

export type PhoneDeferralCode = (typeof PHONE_DEFERRAL_CODES)[number];

export interface PhoneAdmissionRequest {
  readonly engagementId: string;
  /**
   * The candidate whose consent the ADVISORY preflight reads.
   *
   * CALLER'S INVARIANT: this must be the engagement's own candidate. 0042
   * derives it from the LOCKED engagement row (`v_eng.candidate_id`) and this
   * module deliberately owns no read that could check the pair. The
   * consequence is bounded rather than dangerous — only `admit_phone_attempt`
   * grants, and it re-reads consent from the engagement's own candidate — so a
   * mismatched pair can produce a misleading advisory REASON, never a wrong
   * admission.
   */
  readonly candidateId: string;
  readonly kind: PhoneAttemptKind;
  /**
   * SHA-256 hex digest of the candidate's E.164 number — never the number.
   * Optional: when absent the allowlist gate defers rather than passing, which
   * is the fail-closed reading.
   */
  readonly phoneDigest?: string;
  readonly leaseOwner?: string | null;
  readonly leaseSeconds?: number;
  /** Injected. Every gate below and the RPC itself read THIS instant. */
  readonly now: Date;
  /**
   * Whether the caller's runtime has finished warming — its transport, its
   * scanner, whatever a later phase depends on. INJECTED, because this module
   * owns no readiness probe and must not pretend to: an unanswerable question
   * answered locally is how a fail-closed gate becomes fail-open.
   *
   * Defaults to `true` so a caller with nothing to warm is not blocked. Passing
   * `false` defers with `cold_start` — the runtime is not ready, so NO CALL WAS
   * PLACED, which is a wait and never a `provider_error` charged against our
   * own boot time.
   */
  readonly runtimeReady?: boolean;
  /**
   * Optional NARROWING of the database window.
   *
   * `IstWindowBounds` is a structural type, so a caller can hand this a pair
   * that WIDENS the window and TypeScript will accept it. The facade therefore
   * re-runs `narrowIstWindow` over whatever it is given rather than trusting
   * it: a widening throws here instead of silently producing a `retryAfter`
   * the database would never honour. An unenforced comment is not a control.
   */
  readonly windowBounds?: IstWindowBounds;
}

export type PhoneAdmissionResult =
  | {
      readonly decision: 'deferred';
      readonly code: PhoneDeferralCode;
      /** The consent refusal, when the deferral came from the preflight. */
      readonly consentRefusal?: ConsentPreflightRefusal;
      /** For `window_closed`, the next legal instant, mirroring the SQL helper. */
      readonly retryAfter?: Date;
      /** Nothing was written and no budget moved. Always true on this branch. */
      readonly charged: false;
    }
  | {
      readonly decision: 'refused';
      /** The DATABASE'S answer, verbatim. Never a locally substituted code. */
      readonly status: Exclude<AdmitPhoneAttemptStatus, 'ok'> | typeof PHONE_RPC_UNKNOWN_STATUS;
      readonly result: AdmitPhoneAttemptResult;
      readonly charged: false;
    }
  | {
      readonly decision: 'admitted';
      /** Returning this means LIVE WORK EXISTS: an attempt row and a dial job. */
      readonly result: AdmitPhoneAttemptResult;
      readonly charged: false;
    };

export interface PhoneAdmissionDeps {
  readonly stores: PhoneStores;
  readonly config: PhoneScreeningConfig;
  readonly consentReader: ConsentReader;
}

/**
 * Run every pre-claim gate, then — only if none objected — ask the database.
 *
 * The gate ORDER is cheapest-and-most-static first, so a disabled deployment
 * never reaches a consent read and a cold runtime never reaches the window
 * arithmetic. Reordering changes which code an operator sees, not whether a
 * call happens.
 */
export async function admitPhoneEngagement(
  deps: PhoneAdmissionDeps,
  request: PhoneAdmissionRequest,
): Promise<PhoneAdmissionResult> {
  const { config, stores, consentReader } = deps;

  if (!config.screeningEnabled) {
    return { decision: 'deferred', code: 'screening_disabled', charged: false };
  }
  if (!config.runtimeEnabled) {
    return { decision: 'deferred', code: 'runtime_disabled', charged: false };
  }
  if (request.runtimeReady === false) {
    // A cold runtime has placed no call. Deferring costs a poll; charging a
    // provider failure for our own boot time would spend a candidate's budget
    // on our downtime.
    return { decision: 'deferred', code: 'cold_start', charged: false };
  }
  if (config.dialMode === 'off') {
    return { decision: 'deferred', code: 'dial_mode_off', charged: false };
  }
  if (config.dialMode === 'live') {
    // The digest gate applies only to `live`. `synthetic` reaches no carrier,
    // so an allowlist there would block the very rehearsal it exists to permit.
    if (!request.phoneDigest || !isDialAllowedForDigest(config, request.phoneDigest)) {
      return { decision: 'deferred', code: 'dial_not_allowlisted', charged: false };
    }
  }

  // Advisory only. The RPC re-evaluates the window under its own lock at the
  // moment of dialling. Re-narrowing here is what MAKES the next sentence true
  // rather than merely claimed: a supplied bound that widens throws, so a local
  // window can only ever defer EARLIER than the database would, never later.
  const bounds = request.windowBounds === undefined
    ? undefined
    : narrowIstWindow(request.windowBounds);
  if (!istWindowOpen(request.now, bounds)) {
    return {
      decision: 'deferred',
      code: 'window_closed_defer',
      retryAfter: nextIstWindowOpen(request.now, bounds),
      charged: false,
    };
  }

  const consent = await consentPreflight(consentReader, request.candidateId, request.now);
  if (consent.decision === 'refused') {
    return {
      decision: 'deferred',
      code: 'consent_preflight_refused',
      consentRefusal: consent.code,
      charged: false,
    };
  }
  // `no_local_objection` authorises NOTHING. The only thing that can grant a
  // dial is the call below.

  const result = await stores.admitAttempt({
    engagementId: request.engagementId,
    kind: request.kind,
    leaseOwner: request.leaseOwner ?? null,
    leaseSeconds: request.leaseSeconds ?? config.leaseSeconds,
    now: request.now,
  });

  if (result.status === 'ok') return { decision: 'admitted', result, charged: false };

  // The database refused. Its status is surfaced UNTRANSLATED — including the
  // consent refusals the preflight just declined to raise. A local code
  // substituted here would tell an operator the wrong thing about which layer
  // said no, and `unknown_status` deliberately lands here too: an answer we do
  // not recognise is never an admission.
  return { decision: 'refused', status: result.status, result, charged: false };
}
