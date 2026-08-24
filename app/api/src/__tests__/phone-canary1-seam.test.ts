/**
 * PR105 — the originate seam and the whole-run orchestration.
 *
 * ── THE CLAIM THIS FILE DEFENDS ───────────────────────────────────────
 * "No environment variable anywhere changes." Canary-1 gets a live SIP client
 * from an IN-PROCESS config, which is possible only because `isLiveDialPermitted`
 * and `isPhoneTransportReady` are pure functions over injected data. The
 * deployed API's flags, the Fly secrets, `PHONE_DIAL_MODE` and the allowlist
 * are all untouched — so nothing a real candidate's dial reads is weakened.
 *
 * The tests below prove the other half: remove any ONE of the four conditions
 * from that in-process config and the resolver yields the SYNTHETIC client,
 * from which the SDK is unreachable. "Off", "misconfigured" and "synthetic"
 * all fail into the same place: no network.
 *
 * No test here constructs `createLiveSipClient`; every client is injected.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CANARY1_CONFIRM_PHRASE,
  CANARY1_DISPATCH_MODE,
  CANARY1_EPOCH,
  CANARY1_NOT_ARMED,
  CANARY1_PARTICIPANT_ATTRIBUTES,
  buildCanary1DialConfig,
  buildCanary1ScreeningConfig,
  mintCanary1Ids,
  originateCanary1Call,
  runCanary1,
  type Canary1DispatchClientLike,
  type Canary1Ids,
  type Canary1PromptInterface,
  type Canary1RoomClientLike,
  type Canary1RunDeps,
} from '../lib/phone-canary1/index.js';
import {
  PHONE_EPOCH_ATTRIBUTE,
  phoneParticipantIdentity,
  wrapDialableNumber,
  type PhoneOriginateRequest,
  type PhoneSipClient,
} from '../integrations/livekit-phone-dial/index.js';

/**
 * SYNTHETIC, and never the owner's. The same value `test_phone_gate.py` uses as
 * `_NUMBER_LIKE`, kept identical on purpose so a grep for a number-shaped
 * literal in this repository finds one fixture rather than several. It exists
 * only to be proved ABSENT from output.
 */
const FAKE_NUMBER = '+919812345670';
const TRUNK = 'ST_canary_trunk';
const CREDS = { url: 'wss://example.invalid', apiKey: 'key', apiSecret: 'secret' };

function fakeSipClient(): { client: PhoneSipClient; seen: PhoneOriginateRequest[] } {
  const seen: PhoneOriginateRequest[] = [];
  return {
    seen,
    client: {
      mode: 'live',
      async createSipParticipant(request) {
        seen.push(request);
        return {
          participantIdentity: phoneParticipantIdentity(request.attemptId),
          sipCallId: 'opaque-call-id',
          synthetic: false,
        };
      },
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 1. The originate request — every field, and the identity's SOURCE.
// ══════════════════════════════════════════════════════════════════════

describe('1. the originate seam carries exactly what it must', () => {
  const ids = mintCanary1Ids();
  const number = wrapDialableNumber(FAKE_NUMBER);
  const config = buildCanary1ScreeningConfig(number.digest, 30);
  const dialConfig = buildCanary1DialConfig(TRUNK, 'phone-screener', 60, 180);

  async function originate(over: Partial<Canary1Ids> = {}): Promise<PhoneOriginateRequest> {
    const fake = fakeSipClient();
    const outcome = await originateCanary1Call(
      {
        ids: { ...ids, ...over },
        roomName: `phone-${ids.sessionId}`,
        number,
        config,
        dialConfig,
        credentials: CREDS,
        ringSeconds: 30,
        maxCallSeconds: 180,
      },
      { live: () => fake.client },
    );
    expect(outcome.status).toBe('answered');
    expect(fake.seen).toHaveLength(1);
    return fake.seen[0] as PhoneOriginateRequest;
  }

  it('passes the trunk id, the room, and all three time bounds in SECONDS', async () => {
    const request = await originate();
    expect(request.trunkId).toBe(TRUNK);
    expect(request.roomName).toBe(`phone-${ids.sessionId}`);
    // All three explicit. An unset billable ceiling is an omission, not a default.
    expect(request.ringTimeoutSeconds).toBe(30);
    expect(request.originateTimeoutSeconds).toBe(60);
    expect(request.maxCallSeconds).toBe(180);
    expect(request.epoch).toBe(CANARY1_EPOCH);
  });

  it('derives the participant identity from originateAttemptId, PROVABLY not from the others', async () => {
    const request = await originate();
    expect(request.attemptId).toBe(ids.originateAttemptId);
    expect(request.attemptId).not.toBe(ids.sessionId);
    expect(request.attemptId).not.toBe(ids.canaryId);
    expect(phoneParticipantIdentity(request.attemptId))
      .toBe(`phone-${ids.originateAttemptId}`);
    // NON-VACUOUS: if the wiring used the session id instead, this is the
    // value that would arrive — the exact bug `phone.py` records this lane
    // having shipped once, where every event resolved to no attempt at all.
    expect(phoneParticipantIdentity(ids.sessionId)).not.toBe(
      phoneParticipantIdentity(ids.originateAttemptId),
    );
  });

  it('hands the seam a self-redacting number, never a string', async () => {
    const request = await originate();
    expect(String(request.number)).toBe('[redacted]');
    expect(JSON.stringify({ n: request.number })).toBe('{"n":"[redacted]"}');
  });

  it('sets exactly one participant attribute, by exact key', () => {
    expect(Object.keys(CANARY1_PARTICIPANT_ATTRIBUTES)).toEqual([PHONE_EPOCH_ATTRIBUTE]);
    expect(CANARY1_PARTICIPANT_ATTRIBUTES[PHONE_EPOCH_ATTRIBUTE]).toBe(String(CANARY1_EPOCH));
  });

  it('CROSS-FILE PIN — the live client still hides the number from room state', () => {
    // The canary relies on `hidePhoneNumber: true`, which lives in `sip.ts`.
    // Asserting it here means the canary's claim goes red if that line is ever
    // dropped, rather than quietly becoming false.
    const sip = readFileSync(
      fileURLToPath(new URL('../integrations/livekit-phone-dial/sip.ts', import.meta.url)),
      'utf8',
    );
    expect(sip).toContain('hidePhoneNumber: true');
    expect(sip).toContain('unwrapDialableNumber(request.number)');
    // And the unwrap still has exactly ONE call site in the whole package.
    const unwraps = [...sip.matchAll(/unwrapDialableNumber\(/g)].length;
    expect(unwraps).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. Remove any one condition and the SDK becomes unreachable.
// ══════════════════════════════════════════════════════════════════════

describe('2. every gate fails into the synthetic client', () => {
  const number = wrapDialableNumber(FAKE_NUMBER);
  const base = {
    ids: mintCanary1Ids(),
    roomName: 'phone-x',
    number,
    config: buildCanary1ScreeningConfig(number.digest, 30),
    dialConfig: buildCanary1DialConfig(TRUNK, 'phone-screener', 60, 180),
    credentials: CREDS,
    ringSeconds: 30,
    maxCallSeconds: 180,
  };

  it('the assembled config permits a live client', async () => {
    const fake = fakeSipClient();
    const outcome = await originateCanary1Call(base, { live: () => fake.client });
    expect(outcome.status).toBe('answered');
  });

  it.each([
    ['screeningEnabled', { screeningEnabled: false }],
    ['runtimeEnabled', { runtimeEnabled: false }],
    ['dialMode', { dialMode: 'synthetic' as const }],
    ['dialAllowlist', { dialAllowlist: [] as readonly string[] }],
  ])('removing %s yields no provider contact', async (_label, over) => {
    const fake = fakeSipClient();
    const outcome = await originateCanary1Call(
      { ...base, config: { ...base.config, ...over } },
      { live: () => fake.client },
    );
    expect(outcome.status).toBe('dial_not_permitted');
    expect(fake.seen).toEqual([]);
  });

  it('an unconfigured trunk yields no provider contact', async () => {
    const fake = fakeSipClient();
    const outcome = await originateCanary1Call(
      { ...base, dialConfig: { ...base.dialConfig, sipTrunkId: '' } },
      { live: () => fake.client },
    );
    expect(outcome.status).toBe('dial_not_permitted');
    expect(fake.seen).toEqual([]);
  });

  it('missing credentials yield no provider contact', async () => {
    const fake = fakeSipClient();
    const outcome = await originateCanary1Call(
      { ...base, credentials: { ...CREDS, apiSecret: '' } },
      { live: () => fake.client },
    );
    expect(outcome.status).toBe('dial_not_permitted');
    expect(fake.seen).toEqual([]);
  });

  it('a failing originate reports providerContacted TRUE and discards the error', async () => {
    const outcome = await originateCanary1Call(base, {
      live: () => ({
        mode: 'live',
        createSipParticipant: async () => {
          throw new Error(`rpc failed for ${FAKE_NUMBER}`);
        },
      }),
    });
    expect(outcome).toEqual({ status: 'originate_failed', providerContacted: true });
    // The error object did not survive: the outcome carries a stable code and
    // nothing else. A caller deciding whether this is chargeable needs the
    // difference between "we refused" and "we tried and it failed".
    expect(JSON.stringify(outcome)).not.toContain('9812345670');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. The whole run — ordering, the arming gate, and provider call counts.
// ══════════════════════════════════════════════════════════════════════

interface Harness {
  readonly deps: Canary1RunDeps;
  readonly calls: string[];
  readonly lines: string[];
  readonly seen: PhoneOriginateRequest[];
  readonly dispatches: Array<{ room: string; agent: string; metadata: string }>;
}

function harness(over: Partial<Canary1RunDeps> = {}, answers = [FAKE_NUMBER, FAKE_NUMBER]): Harness {
  const calls: string[] = [];
  const lines: string[] = [];
  const dispatches: Array<{ room: string; agent: string; metadata: string }> = [];
  const fake = fakeSipClient();
  let listCount = 0;

  const rooms: Canary1RoomClientLike = {
    async createRoom() { calls.push('createRoom'); },
    async deleteRoom() { calls.push('deleteRoom'); },
    async listRooms() {
      calls.push('listRooms');
      listCount += 1;
      // Occupied once, then gone — the shape of a completed canary call.
      return listCount === 1 ? [{ numParticipants: 2 }] : [];
    },
  };
  const dispatch: Canary1DispatchClientLike = {
    async createDispatch(room, agent, options) {
      calls.push('createDispatch');
      dispatches.push({ room, agent, metadata: options.metadata });
    },
  };
  const openPrompt = (): Canary1PromptInterface => {
    const history: string[] = [];
    return {
      question: async () => answers.shift() ?? '',
      history,
      close: () => {},
    };
  };
  let clock = 1_000;
  const deps: Canary1RunDeps = {
    argv: ['--execute', '--confirm', CANARY1_CONFIRM_PHRASE],
    env: {},
    write: (line) => lines.push(line),
    prompt: { openPrompt, isTty: true },
    rooms,
    dispatch,
    credentials: CREDS,
    trunkId: TRUNK,
    sleep: async () => { clock += 2_000; },
    now: () => { clock += 10; return clock; },
    originate: { live: () => fake.client },
    armed: true,
    // Hermetic: a developer with a real `app/api/.env` on disk would
    // otherwise see every run here refuse `credentials_persisted`.
    // The entry script passes NO reader, which the structural suite
    // asserts, so production always uses the path-pinned read.
    readEnvFile: () => null,
    ...over,
  };
  return { deps, calls, lines, seen: fake.seen, dispatches };
}

describe('3. one invocation, one room, at most one originate', () => {
  it('creates, dispatches, originates once, observes, then tears down', async () => {
    const h = harness();
    const result = await runCanary1(h.deps);
    expect(h.seen).toHaveLength(1);
    expect(h.calls.indexOf('createRoom')).toBeLessThan(h.calls.indexOf('createDispatch'));
    expect(h.calls.filter((c) => c === 'createRoom')).toHaveLength(1);
    expect(h.calls.filter((c) => c === 'deleteRoom').length).toBeGreaterThanOrEqual(1);
    expect(result.providerContacted).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.lines.at(-1)).toBe('CANARYDONE|1');
  });

  it('dispatches CANARY metadata — with no attempt id and no epoch', async () => {
    const h = harness();
    await runCanary1(h.deps);
    expect(h.dispatches).toHaveLength(1);
    const payload = JSON.parse(h.dispatches[0]?.metadata as string) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['canary_id', 'channel', 'mode', 'session_id']);
    expect(payload.mode).toBe(CANARY1_DISPATCH_MODE);
    expect(payload).not.toHaveProperty('attempt_id');
    expect(payload).not.toHaveProperty('epoch');
    expect(h.dispatches[0]?.agent).toBe('phone-screener');
  });

  it('DISARMED — refuses before the prompt and before EVERY provider call', async () => {
    const h = harness({ armed: false });
    const result = await runCanary1(h.deps);
    expect(result.providerContacted).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.seen).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(`CANARY|canary1|armed|FAIL|${CANARY1_NOT_ARMED}`);
    // The operator was never asked to type their number into a run that could
    // not use it: the two prompt answers are still unconsumed.
    expect(result.lines.some((l) => l.includes('preflight_destination_accepted'))).toBe(false);
  });

  it('a DRY RUN dispatches and tears down without originating', async () => {
    const h = harness({ argv: [] });
    const result = await runCanary1(h.deps);
    expect(h.seen).toEqual([]);
    expect(h.calls).toContain('createDispatch');
    expect(result.lines).toContain('CANARY|canary1|originate_skipped|PASS|dry_run');
    expect(result.exitCode).toBe(0);
  });

  it('a failed preflight touches no client at all', async () => {
    const h = harness({ trunkId: '' });
    const result = await runCanary1(h.deps);
    expect(h.calls).toEqual([]);
    expect(result.providerContacted).toBe(false);
    expect(result.lines)
      .toContain('CANARY|canary1|preflight_trunk_configured|FAIL|trunk_not_configured');
  });

  it('a persisted LiveKit credential refuses before the prompt and before any client', async () => {
    // M-4: a dotfile holding production LiveKit credentials is exactly the
    // durability the rest of this design avoids. The injected reader is what
    // makes this assertion hermetic; the structural suite asserts the entry
    // script passes none, so production always reads the pinned path.
    const h = harness({ readEnvFile: () => 'SUPABASE_URL=x\nLIVEKIT_API_KEY=secret\n' });
    const result = await runCanary1(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.seen).toEqual([]);
    expect(result.providerContacted).toBe(false);
    expect(result.lines)
      .toContain('CANARY|canary1|credentials_transient|FAIL|credentials_persisted');
  });

  it('a dotfile without a LiveKit key is not a refusal', async () => {
    const h = harness({ readEnvFile: () => 'SUPABASE_URL=x\nPHONE_AGENT_NAME=y\n' });
    const result = await runCanary1(h.deps);
    expect(result.lines).toContain('CANARY|canary1|credentials_transient|PASS|ok');
  });

  it('a destination-shaped environment variable refuses before the prompt', async () => {
    const h = harness({ env: { CANARY_TO: FAKE_NUMBER } });
    const result = await runCanary1(h.deps);
    expect(h.calls).toEqual([]);
    expect(result.lines)
      .toContain('CANARY|canary1|environment_accepted|FAIL|destination_in_environment');
  });

  it('a room that never opens does not dispatch and still tears down', async () => {
    const h = harness();
    const result = await runCanary1({
      ...h.deps,
      rooms: {
        ...h.deps.rooms,
        createRoom: async () => { throw new Error('provider said no'); },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain('CANARY|canary1|room_created|FAIL|room_create_failed');
    expect(result.lines.some((l) => l.startsWith('CANARY|canary1|teardown_room_'))).toBe(true);
    expect(result.lines.at(-1)).toBe('CANARYDONE|1');
  });
});
