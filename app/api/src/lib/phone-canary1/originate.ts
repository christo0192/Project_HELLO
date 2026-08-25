/**
 * lib/phone-canary1/originate.ts — the in-process configuration, the room and
 * dispatch calls, and the one originate.
 *
 * ── NO ENVIRONMENT VARIABLE ANYWHERE CHANGES ──────────────────────────
 * This is the single most important property of the whole mechanism, and it is
 * available only because of how P4a built the gates: `isLiveDialPermitted` and
 * `isPhoneTransportReady` are PURE FUNCTIONS OVER INJECTED DATA. So the canary
 * assembles a `PhoneScreeningConfig` in its own memory, hands it to
 * `resolvePhoneSipClient`, and gets a live client — while the deployed API's
 * configuration, the Fly secrets, the allowlist and `PHONE_DIAL_MODE` are all
 * exactly what they were. Nothing is weakened for a real candidate because
 * nothing a real candidate's dial reads is touched.
 *
 * The documented alternative — the ladder in `phone-safe-dialer.md` §9 step 6:
 * both flags plus `PHONE_DIAL_MODE=live` plus a one-entry allowlist — is three
 * FLEET-WIDE weakenings for one call, and hands the choice of who gets dialled
 * to the due loop rather than to a human at a terminal.
 *
 * ── THE ALLOWLIST CHECK IS EXERCISED AND VACUOUS, AND BOTH ARE SAID ───
 * The allowlist is built one line before the check, from the same value the
 * check is about. `isDialAllowedForDigest` therefore cannot fail here. It is
 * still called, because the real gate should be on the real path — but nobody
 * may later read "the allowlist was checked" as evidence about this run. The
 * control that actually stands between a typo and a stranger's handset is
 * double entry at the TTY.
 *
 * That is also why no digest is published anywhere durable.
 * `PHONE_DIAL_ALLOWLIST` holds UNSALTED SHA-256 digests of E.164 values, and
 * for an Indian mobile the space is `+91[6-9]` plus nine digits — about four
 * billion, exhaustible on a laptop. A committed digest of the owner's number
 * IS the number. The digest here exists only as a transient inside one
 * short-lived process.
 *
 * ── AND THE PARTICIPANT IDENTITY COMES FROM THE THIRD ID ──────────────
 * `createLiveSipClient` derives `phone-<attemptId>` from the request's
 * `attemptId`. The canary passes `originateAttemptId` there — never
 * `sessionId`, which is what the room is named after, and never `canaryId`.
 * `phone.py` records that this lane has already shipped a session id in the
 * attempt-id position once, and every event posted under it resolved to no
 * attempt at all.
 */

// ── EVERY IMPORT BELOW NAMES A LEAF MODULE, NEVER A DIRECTORY BARREL ──
// PR108. `resolvePhoneSipClient` used to be imported from
// `livekit-phone-dial/index.js`. That barrel re-exports `phone-room.ts`, which
// imports `lib/room-provisioning.ts`, which imports `lib/env.ts` — and
// `lib/env.ts` throws at module scope when `SUPABASE_URL` is unset. A barrel
// re-export is EAGER: ESM evaluates every re-exported module even when the
// importer names one symbol. So the operator's terminal got
// `process_containment|FAIL|uncaught_exception` and nothing else — before the
// arming gate, before any prompt, with the cause inside the containment layer
// that exists to keep error objects off the screen.
//
// A second, quieter consequence, which did not fire in the incident but was
// one populated variable away from doing so: `lib/env.ts` opens with
// `import 'dotenv/config'`, which merges a `.env` read FROM THE PROCESS CWD
// into `process.env`. This mechanism refuses to run beside persisted LiveKit
// credentials — `credentials_persisted` — but that refusal reads a path pinned
// relative to the module, so under any other cwd the barrel could have loaded
// a dotfile the refusal never looked at. The repair removes `dotenv` from the
// closure outright rather than reasoning about which cwd is safe.
//
// The canary CLI is not the API. It holds no Supabase credential and must
// require none. These imports are therefore pinned to the exact leaf modules
// that define the symbols, and `phone-canary1-import-closure.test.ts` walks the
// real static graph from both roots and fails if a barrel — or `lib/env` —
// re-enters it.
import {
  resolvePhoneSipClient,
  type PhoneOriginateResult,
  type PhoneSipClient,
  type SipClientResolution,
} from '../../integrations/livekit-phone-dial/sip.js';
import type { DialableNumber } from '../../integrations/livekit-phone-dial/dialable-number.js';
import { isDialAllowedForDigest, type PhoneScreeningConfig } from '../phone-screening/config.js';
import type { PhoneDialConfig } from '../../integrations/livekit-phone-dial/config.js';
import { discardingErrors, scrubVerbosity } from './containment.js';
import { buildCanary1DispatchMetadata, buildCanary1RoomMetadata } from './metadata.js';
import type { Canary1Ids } from './ids.js';
import { CANARY1_ROOM_MAX_PARTICIPANTS } from './plan.js';
import type { Canary1RoomTeardownClientLike } from './teardown.js';

/** The room surface the canary needs: create, plus teardown's delete and list. */
export interface Canary1RoomClientLike extends Canary1RoomTeardownClientLike {
  createRoom(options: {
    name: string;
    emptyTimeout: number;
    maxParticipants: number;
    metadata: string;
  }): Promise<unknown>;
}

/** The named-agent dispatch surface. */
export interface Canary1DispatchClientLike {
  createDispatch(
    roomName: string,
    agentName: string,
    options: { metadata: string },
  ): Promise<unknown>;
}

export interface Canary1Credentials {
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * The in-process screening config. Every field is a decision made HERE, in
 * memory, for the length of one process.
 *
 * The epoch is a literal `0`. There is no attempt row for it to fence, and a
 * fabricated non-zero epoch would look like a re-dispatch of something.
 */
export const CANARY1_EPOCH = 0;

export function buildCanary1ScreeningConfig(
  digest: string,
  ringSeconds: number,
): PhoneScreeningConfig {
  return {
    screeningEnabled: true,
    runtimeEnabled: true,
    dialMode: 'live',
    // Exactly one entry, built from the value typed at the prompt, and never
    // written anywhere. See the header on why this makes the check vacuous.
    dialAllowlist: [digest],
    slotSeconds: 1_800,
    reconnectBackoffSeconds: 120,
    ringTimeoutSeconds: ringSeconds,
    leaseSeconds: 180,
    webhookMaxBytes: 65_536,
    webhookToleranceSeconds: 300,
  };
}

export function buildCanary1DialConfig(
  trunkId: string,
  agentName: string,
  originateTimeoutSeconds: number,
  maxCallSeconds: number,
): PhoneDialConfig {
  return { sipTrunkId: trunkId, agentName, originateTimeoutSeconds, maxCallSeconds };
}

export type Canary1RoomOutcome = 'created' | 'room_create_failed';
export type Canary1DispatchOutcome = 'dispatched' | 'dispatch_failed';

/**
 * Create the canary room. Closed-key metadata, both bounds explicit.
 *
 * `emptyTimeout` is a PARAMETER, not a constant read here. It is derived from
 * the run's own participant wait by `canary1RoomEmptyTimeoutSeconds` and
 * checked by the preflight's fourth inequality before this function is
 * reached, so the room provably outlives the window in which the CLI is still
 * waiting for the worker to appear in it. A constant read here is exactly the
 * shape that let a chosen 120 sit under a 180 s join window.
 */
export async function createCanary1Room(
  ids: Canary1Ids,
  roomName: string,
  rooms: Canary1RoomClientLike,
  emptyTimeoutSeconds: number,
): Promise<Canary1RoomOutcome> {
  const created = await discardingErrors(async () => {
    await rooms.createRoom({
      name: roomName,
      emptyTimeout: emptyTimeoutSeconds,
      maxParticipants: CANARY1_ROOM_MAX_PARTICIPANTS,
      metadata: buildCanary1RoomMetadata(ids),
    });
    return true;
  });
  return created === true ? 'created' : 'room_create_failed';
}

/**
 * Dispatch the named worker.
 *
 * NOT `provisionPhoneRoom`: that builds PRODUCTION metadata, whose key set is
 * closed and must stay closed. Reusing it would mean widening the one
 * constructor that guarantees a real candidate's dispatch cannot be read as a
 * canary.
 */
export async function dispatchCanary1Worker(
  ids: Canary1Ids,
  roomName: string,
  agentName: string,
  mode: string,
  dispatch: Canary1DispatchClientLike,
): Promise<Canary1DispatchOutcome> {
  const done = await discardingErrors(async () => {
    await dispatch.createDispatch(roomName, agentName, {
      metadata: buildCanary1DispatchMetadata(ids, mode),
    });
    return true;
  });
  return done === true ? 'dispatched' : 'dispatch_failed';
}

export interface Canary1OriginateInput {
  readonly ids: Canary1Ids;
  readonly roomName: string;
  readonly number: DialableNumber;
  readonly config: PhoneScreeningConfig;
  readonly dialConfig: PhoneDialConfig;
  readonly credentials: Canary1Credentials;
  readonly ringSeconds: number;
  readonly maxCallSeconds: number;
}

export type Canary1OriginateOutcome =
  | { readonly status: 'answered'; readonly result: PhoneOriginateResult; readonly mode: 'live' | 'synthetic' }
  | { readonly status: 'dial_not_permitted'; readonly providerContacted: false }
  | { readonly status: 'originate_failed'; readonly providerContacted: true };

export interface Canary1OriginateDeps {
  /** Injected so a test can resolve a fake and never construct a live client. */
  readonly resolve?: typeof resolvePhoneSipClient;
  readonly live?: (url: string, apiKey: string, apiSecret: string) => PhoneSipClient;
  readonly synthetic?: () => PhoneSipClient;
}

/**
 * The one originate. No retry, ever — not on failure, not on no-answer, not on
 * anything. A retry loop on a live carrier is a second chargeable call to a
 * handset, decided by a program rather than by the person at the terminal.
 */
export async function originateCanary1Call(
  input: Canary1OriginateInput,
  deps: Canary1OriginateDeps = {},
): Promise<Canary1OriginateOutcome> {
  // Exercised, and vacuous by construction. See the header.
  if (!isDialAllowedForDigest(input.config, input.number.digest)) {
    return { status: 'dial_not_permitted', providerContacted: false };
  }

  const resolve = deps.resolve ?? resolvePhoneSipClient;
  const resolution: SipClientResolution = resolve(
    input.config,
    input.dialConfig,
    input.credentials,
    { live: deps.live, synthetic: deps.synthetic },
  );
  if (resolution.client.mode !== 'live') {
    return { status: 'dial_not_permitted', providerContacted: false };
  }

  const result = await discardingErrors(async () =>
    resolution.client.createSipParticipant({
      trunkId: input.dialConfig.sipTrunkId,
      number: input.number,
      roomName: input.roomName,
      // THE THIRD ID. Not the session id, not the canary id.
      attemptId: input.ids.originateAttemptId,
      epoch: CANARY1_EPOCH,
      originateTimeoutSeconds: input.dialConfig.originateTimeoutSeconds,
      ringTimeoutSeconds: input.ringSeconds,
      maxCallSeconds: input.maxCallSeconds,
    }));

  if (result === undefined) {
    // The provider WAS contacted. The error object is gone; the fact is not.
    return { status: 'originate_failed', providerContacted: true };
  }
  return { status: 'answered', result, mode: resolution.client.mode };
}

/**
 * Build the real LiveKit room and dispatch clients.
 *
 * Lazy, exactly as `lib/phone-runtime/livekit-clients.ts` is lazy and for the
 * same reason: several suites partially mock `livekit-server-sdk`, and merely
 * importing this module must open nothing. NO TEST CALLS THIS — a test that
 * did would be one credential away from a real room, and the suite asserts
 * that `createLiveSipClient` is never named in a test file.
 *
 * The verbosity keys are scrubbed from the environment map the SDK will read
 * before it is constructed, so no debug level can turn a provider message into
 * a line on stderr.
 */
export function createCanary1LiveClients(
  credentials: Canary1Credentials,
  env: NodeJS.ProcessEnv,
): { rooms: Canary1RoomClientLike; dispatch: Canary1DispatchClientLike } {
  // THE SCRUB, applied to the map the SDK will actually read. The entry script
  // scrubs at startup too; this is the belt, so a caller that skipped the
  // startup scrub still cannot hand the SDK a debug level. It mutates rather
  // than copies deliberately — a scrubbed clone the constructor never reads is
  // a control that reads like a guarantee and is not one.
  scrubVerbosity(env);

  let roomService: {
    createRoom: (opts: unknown) => Promise<unknown>;
    deleteRoom: (name: string) => Promise<unknown>;
    listRooms: (names?: string[]) => Promise<readonly unknown[]>;
  } | null = null;

  async function roomClient(): Promise<NonNullable<typeof roomService>> {
    if (roomService === null) {
      const { RoomServiceClient } = await import('livekit-server-sdk');
      roomService = new RoomServiceClient(
        credentials.url,
        credentials.apiKey,
        credentials.apiSecret,
      ) as unknown as NonNullable<typeof roomService>;
    }
    return roomService;
  }

  const rooms: Canary1RoomClientLike = {
    async createRoom(options) {
      return (await roomClient()).createRoom(options);
    },
    async deleteRoom(name) {
      return (await roomClient()).deleteRoom(name);
    },
    async listRooms(names) {
      // Projected AT THE BOUNDARY to the one field this mechanism reads. The
      // SDK's `Room` carries provider fields we have no use for, and handing
      // the raw object outward is how one of them ends up in a line.
      const listed = await (await roomClient()).listRooms([...names]);
      return listed.map((room) => ({
        numParticipants: (room as { numParticipants?: number }).numParticipants,
      }));
    },
  };

  let agentDispatch: { createDispatch: (...args: unknown[]) => Promise<unknown> } | null = null;
  const dispatch: Canary1DispatchClientLike = {
    async createDispatch(roomName, agentName, options) {
      if (agentDispatch === null) {
        const { AgentDispatchClient } = await import('livekit-server-sdk');
        agentDispatch = new AgentDispatchClient(
          credentials.url,
          credentials.apiKey,
          credentials.apiSecret,
        ) as unknown as NonNullable<typeof agentDispatch>;
      }
      return agentDispatch.createDispatch(roomName, agentName, options);
    },
  };

  return { rooms, dispatch };
}
