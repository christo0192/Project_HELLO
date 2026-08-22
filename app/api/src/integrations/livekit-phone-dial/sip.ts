/**
 * livekit-phone-dial/sip.ts — the outbound originate seam.
 *
 * ── THE STRUCTURAL RULE THIS FILE ENFORCES ────────────────────────────
 * There are exactly TWO implementations of `PhoneSipClient` in this
 * repository, and only ONE of them can reach a carrier:
 *
 *   * `createSyntheticSipClient()` — a local fake. This module-level factory
 *     contains no import of `livekit-server-sdk`, static or dynamic, and a
 *     structural test asserts that its body names no SDK symbol. `synthetic`
 *     mode is therefore not "a live client we promise not to call": it is a
 *     code path from which the SDK is UNREACHABLE.
 *   * `createLiveSipClient()` — the real one, behind a lazy dynamic import.
 *
 * `resolvePhoneSipClient` is the only selector, and it hands back the live
 * client ONLY when `isLiveDialPermitted(config)` is true — which already
 * requires the master switch, the runtime switch, `dialMode === 'live'`, a
 * NON-EMPTY digest allowlist and a configured trunk. Every other
 * configuration yields the synthetic client, so "off", "misconfigured" and
 * "synthetic" all fail into the same place: no network.
 *
 * The reason this is structural rather than conditional is the integrated
 * plan's Canary-0 / Canary-1 split. A "synthetic canary" that quietly places
 * one real billable call to a real person is the exact failure the split
 * exists to prevent, and a boolean guard inside one shared client is one
 * refactor away from being inverted.
 *
 * ── THE SDK CALL IS PINNED, INCLUDING ITS UNITS ───────────────────────
 * `SipClient.createSipParticipant(sipTrunkId, number, roomName, opts?)` —
 * note the lowercase `ip`, which is easy to mistype as `createSIPParticipant`
 * and which TypeScript would catch only because we call the real type. All
 * three time bounds are plain numbers in SECONDS, and all three are set
 * EXPLICITLY rather than left to a provider default:
 *
 *   * `timeout`          — how long the originate CALL may block. The SDK
 *     default is 60 s when `waitUntilAnswered` is true, which is exactly the
 *     default concurrency lease, so leaving it unset races the reclaimer.
 *   * `ringingTimeout`   — how long the line may ring before it is a
 *     no-answer. Distinct from the above; conflating them is why the two
 *     knobs are named apart in `PHONE_BOUNDS`.
 *   * `maxCallDuration`  — the hard ceiling on a connected call. An unset
 *     billable ceiling is not a default, it is an omission.
 *
 * `hidePhoneNumber: true` keeps the dialled number out of the room's
 * participant list, so a later reader of room state cannot recover it.
 *
 * ── WHAT CROSSES THE BOUNDARY ─────────────────────────────────────────
 * IN: a `DialableNumber` whose default rendering is `[redacted]`. OUT: the
 * participant identity and, when the provider supplies one, an opaque SIP call
 * id. Never the number, never the raw SDK object, never a provider payload.
 */

import {
  APPROVED_PARTICIPANT_ATTRIBUTES,
} from '../livekit-phone/events.js';
import { unwrapDialableNumber, type DialableNumber } from './dialable-number.js';
import {
  isLiveDialPermitted,
  type PhoneScreeningConfig,
} from '../../lib/phone-screening/index.js';
import { isPhoneTransportReady, type PhoneDialConfig } from './config.js';

/**
 * The participant attribute carrying the fencing epoch.
 *
 * NOT a second copy of the string. It is INDEXED out of the allowlist P3
 * exports, so a rename in either lane is a type error here rather than a
 * silent fencing degradation — 0042 coalesces a missing epoch to the attempt's
 * own, so a renamed attribute would fail quietly, which is the worst way for a
 * fencing token to fail. A joint test asserts this equals P3's constant.
 */
export const PHONE_EPOCH_ATTRIBUTE: (typeof APPROVED_PARTICIPANT_ATTRIBUTES)[number] =
  APPROVED_PARTICIPANT_ATTRIBUTES[0];

/** Deterministic participant identity — the form 0042's CHECK admits. */
export function phoneParticipantIdentity(attemptId: string): string {
  return `phone-${attemptId}`;
}

export interface PhoneOriginateRequest {
  readonly trunkId: string;
  readonly number: DialableNumber;
  readonly roomName: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly originateTimeoutSeconds: number;
  readonly ringTimeoutSeconds: number;
  readonly maxCallSeconds: number;
}

export interface PhoneOriginateResult {
  /** Always the deterministic identity we asked for. */
  readonly participantIdentity: string;
  /** Opaque provider call id when supplied. Matches 0042's CHECK or is dropped. */
  readonly sipCallId?: string;
  /** `true` only for the synthetic client, so a caller can assert the mode. */
  readonly synthetic: boolean;
}

/** The seam. One method, because one is all a dialer needs. */
export interface PhoneSipClient {
  readonly mode: 'live' | 'synthetic';
  createSipParticipant(request: PhoneOriginateRequest): Promise<PhoneOriginateResult>;
}

/** 0042's `chk_phone_call_attempts_sip_call_id`, mirrored so a bad id is dropped. */
const SIP_CALL_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The SYNTHETIC client. Places no call, opens no socket and — critically —
 * names no SDK symbol, so there is no code path from `synthetic` to a carrier.
 * A structural test asserts this function's source contains no
 * `livekit-server-sdk` reference.
 */
export function createSyntheticSipClient(): PhoneSipClient {
  return {
    mode: 'synthetic',
    async createSipParticipant(request: PhoneOriginateRequest): Promise<PhoneOriginateResult> {
      // The identity is derived exactly as the live path derives it, so a
      // synthetic rehearsal exercises the same downstream resolution the
      // webhook will perform. Nothing else about the provider is simulated:
      // pretending to know a carrier's behaviour would make a green synthetic
      // run evidence about a fake rather than about the code under test.
      return {
        participantIdentity: phoneParticipantIdentity(request.attemptId),
        synthetic: true,
      };
    },
  };
}

/**
 * The LIVE client. The SDK is imported LAZILY for the same reason
 * `verify.ts` and `stores.ts` do it: several suites partially `vi.mock`
 * `livekit-server-sdk`, and a static import in `app.ts`'s graph breaks app
 * load. It also means merely importing this module opens nothing.
 */
export function createLiveSipClient(
  url: string,
  apiKey: string,
  apiSecret: string,
): PhoneSipClient {
  return {
    mode: 'live',
    async createSipParticipant(request: PhoneOriginateRequest): Promise<PhoneOriginateResult> {
      const { SipClient } = await import('livekit-server-sdk');
      const client = new SipClient(url, apiKey, apiSecret);
      const info = await client.createSipParticipant(
        request.trunkId,
        // THE ONLY unwrap in the codebase. Everything upstream of this line
        // handles the number as an opaque, self-redacting value.
        unwrapDialableNumber(request.number),
        request.roomName,
        {
          participantIdentity: phoneParticipantIdentity(request.attemptId),
          // The epoch is the ONLY attribute we set. P3's reader indexes an
          // allowlist of exactly this one key by exact name, so anything else
          // set here would be dropped at the boundary anyway — and setting it
          // would still put it in the room for another reader to find.
          participantAttributes: { [PHONE_EPOCH_ATTRIBUTE]: String(request.epoch) },
          hidePhoneNumber: true,
          // All three explicit, all three in SECONDS. See the header.
          waitUntilAnswered: true,
          timeout: request.originateTimeoutSeconds,
          ringingTimeout: request.ringTimeoutSeconds,
          maxCallDuration: request.maxCallSeconds,
        },
      );
      const rawCallId: unknown = (info as { sipCallId?: unknown }).sipCallId;
      const sipCallId =
        typeof rawCallId === 'string' && SIP_CALL_ID_RE.test(rawCallId) ? rawCallId : undefined;
      // NOTE what is NOT returned: `info` itself. The SDK's
      // `SIPParticipantInfo` carries provider fields we have no use for, and
      // handing the raw object outward is how one of them ends up in a log.
      return {
        participantIdentity: phoneParticipantIdentity(request.attemptId),
        sipCallId,
        synthetic: false,
      };
    },
  };
}

export interface SipClientResolution {
  readonly client: PhoneSipClient;
  /**
   * Why the synthetic client was chosen, when it was. `undefined` for live.
   * A stable code, never a sentence, and never the trunk id.
   */
  readonly reason?: 'not_live_permitted';
}

/**
 * THE ONLY SELECTOR. Returns the live client if and only if
 * `isLiveDialPermitted` holds — master switch AND runtime switch AND
 * `dialMode === 'live'` AND a non-empty digest allowlist AND a configured
 * trunk. Every other configuration, including `synthetic`, yields the client
 * from which the SDK is unreachable.
 */
export function resolvePhoneSipClient(
  config: PhoneScreeningConfig,
  dialConfig: PhoneDialConfig,
  credentials: { url: string; apiKey: string; apiSecret: string },
  deps: {
    live?: (url: string, apiKey: string, apiSecret: string) => PhoneSipClient;
    synthetic?: () => PhoneSipClient;
  } = {},
): SipClientResolution {
  const makeSynthetic = deps.synthetic ?? createSyntheticSipClient;
  if (!isLiveDialPermitted(config) || !isPhoneTransportReady(dialConfig)) {
    return { client: makeSynthetic(), reason: 'not_live_permitted' };
  }
  if (credentials.url === '' || credentials.apiKey === '' || credentials.apiSecret === '') {
    // Credentials are a fourth, independent gate. `isLiveDialPermitted` speaks
    // for the phone flags; it knows nothing about whether LiveKit itself is
    // provisioned, and an unprovisioned live client would throw at the SDK
    // rather than refuse before it.
    return { client: makeSynthetic(), reason: 'not_live_permitted' };
  }
  const makeLive = deps.live ?? createLiveSipClient;
  return { client: makeLive(credentials.url, credentials.apiKey, credentials.apiSecret) };
}
