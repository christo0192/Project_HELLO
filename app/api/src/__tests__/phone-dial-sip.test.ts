/**
 * P5 — the outbound originate seam (`integrations/livekit-phone-dial/sip.ts`)
 * and the self-redacting value it takes.
 *
 * Four properties are pinned here, and each one is pinned because losing it
 * would be SILENT:
 *
 *   1. THE SDK CALL, INCLUDING ITS UNITS. `createSipParticipant` (lowercase
 *      `ip`) takes four POSITIONAL arguments and an options bag whose three
 *      time bounds are SECONDS. A millisecond/second confusion does not throw
 *      — it produces a call that rings for 45 000 s or a billable ceiling of
 *      15 minutes' worth of milliseconds. So the fixtures use three DISTINCT
 *      configured values (30 / 45 / 900) and each is asserted for exact
 *      equality with the configured number and for inequality with its
 *      thousand-fold.
 *   2. EXACTLY ONE PARTICIPANT ATTRIBUTE, and it is P3's allowlisted key.
 *   3. NOTHING OF THE PROVIDER COMES BACK. Not the number, not the raw
 *      `SIPParticipantInfo`, not a field a future SDK release adds.
 *   4. THE GATING TABLE. Every configuration except the fully-permitted one
 *      yields the synthetic client, from which the SDK is unreachable.
 *
 * No network and no real SDK: `livekit-server-sdk` is mocked wholesale, and
 * the mock is also the witness that the synthetic path touches nothing.
 * `process.env` is never mutated — both configs are built from injected maps.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import util from 'node:util';

/**
 * Hoisted so the `vi.mock` factory can reach it. The arrays ARE the assertion
 * surface: a constructor call and an originate call cannot happen without
 * landing here, so "no network" is observed rather than assumed.
 */
const sdk = vi.hoisted(() => ({
  constructed: [] as Array<readonly [string, string, string]>,
  calls: [] as unknown[][],
  result: {} as Record<string, unknown>,
  error: undefined as Error | undefined,
}));

vi.mock('livekit-server-sdk', () => {
  class SipClient {
    constructor(url: string, apiKey: string, apiSecret: string) {
      sdk.constructed.push([url, apiKey, apiSecret] as const);
    }

    async createSipParticipant(...args: unknown[]): Promise<Record<string, unknown>> {
      sdk.calls.push(args);
      if (sdk.error !== undefined) throw sdk.error;
      return sdk.result;
    }
  }
  return { SipClient };
});

import {
  PHONE_EPOCH_ATTRIBUTE,
  createLiveSipClient,
  createSyntheticSipClient,
  phoneParticipantIdentity,
  resolvePhoneSipClient,
  type PhoneOriginateRequest,
} from '../integrations/livekit-phone-dial/sip.js';
import {
  REDACTED,
  unwrapDialableNumber,
  wrapDialableNumber,
  type DialableNumber,
} from '../integrations/livekit-phone-dial/dialable-number.js';
import {
  loadPhoneDialConfig,
  type PhoneDialConfig,
} from '../integrations/livekit-phone-dial/config.js';
import {
  loadPhoneScreeningConfig,
  type PhoneScreeningConfig,
} from '../lib/phone-screening/index.js';
import { APPROVED_PARTICIPANT_ATTRIBUTES } from '../integrations/livekit-phone/events.js';

// ── FIXTURES ───────────────────────────────────────────────────────────
// The three time knobs are DELIBERATELY all different, and none of them is a
// default that another could be confused with. If the implementation were to
// pass milliseconds, or to pass the same value three times, or to swap the
// originate bound for the ring bound, at least one assertion below fails.
const ORIGINATE_SECONDS = 30;
const RING_SECONDS = 45;
const MAX_CALL_SECONDS = 900;

const TRUNK = 'trunk_canary_01';
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ROOM = 'phone-11111111-2222-4333-8444-555555555555';
const EPOCH = 7;

/**
 * The synthetic fixture number. `+919876543210` is this repo's established
 * phone fixture; it is dialable BY CONSTRUCTION because `wrapDialableNumber`
 * mirrors 0042's `^\+91[6-9][0-9]{9}$` and refuses anything weaker — an
 * undialable placeholder could not exercise the wrapper at all.
 */
const RAW_NUMBER = '+919876543210';
/**
 * Its real SHA-256 — the form the allowlist speaks. Asserted below against
 * `wrapDialableNumber`'s own digest, so this literal cannot drift into a
 * value that merely LOOKS like a digest while matching nothing.
 */
const NUMBER_DIGEST = 'f3a47ce5ce3d4ca8ad15225a245b2759022f79489f5c62719b8c9490f7aab90e';

const URL_ = 'wss://livekit.example.invalid';
const API_KEY = 'APIkey123';
const API_SECRET = 'secret123';

function dialConfig(over: NodeJS.ProcessEnv = {}): PhoneDialConfig {
  return loadPhoneDialConfig({
    PHONE_SIP_TRUNK_ID: TRUNK,
    PHONE_AGENT_NAME: 'phone-agent',
    PHONE_ORIGINATE_TIMEOUT_SECONDS: String(ORIGINATE_SECONDS),
    PHONE_MAX_CALL_SECONDS: String(MAX_CALL_SECONDS),
    ...over,
  } as NodeJS.ProcessEnv);
}

function screeningConfig(over: NodeJS.ProcessEnv = {}): PhoneScreeningConfig {
  return loadPhoneScreeningConfig({
    PHONE_SCREENING_ENABLED: 'true',
    PHONE_RUNTIME_ENABLED: 'true',
    PHONE_DIAL_MODE: 'live',
    PHONE_DIAL_ALLOWLIST: NUMBER_DIGEST,
    PHONE_RING_TIMEOUT_SECONDS: String(RING_SECONDS),
    ...over,
  } as NodeJS.ProcessEnv);
}

function originateRequest(number: DialableNumber): PhoneOriginateRequest {
  const dial = dialConfig();
  const screening = screeningConfig();
  return {
    trunkId: dial.sipTrunkId,
    target: { kind: 'number', number },
    roomName: ROOM,
    attemptId: ATTEMPT,
    epoch: EPOCH,
    // Sourced FROM the configs, so the assertions below are about what the
    // operator configured rather than about three literals typed twice.
    originateTimeoutSeconds: dial.originateTimeoutSeconds,
    ringTimeoutSeconds: screening.ringTimeoutSeconds,
    maxCallSeconds: dial.maxCallSeconds,
  };
}

beforeEach(() => {
  sdk.constructed.length = 0;
  sdk.calls.length = 0;
  sdk.error = undefined;
  sdk.result = { sipCallId: 'SCL_9f8e7d6c' };
});

// ═══════════════════════════════════════════════════════════════════════
// 1. THE SDK CALL IS PINNED, POSITION BY POSITION AND UNIT BY UNIT.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 sip — the exact SDK call', () => {
  it('constructs SipClient with the credentials it was handed, once', async () => {
    const client = createLiveSipClient(URL_, API_KEY, API_SECRET);
    expect(client.mode).toBe('live');
    // Merely creating the client opens nothing: the SDK import is lazy.
    expect(sdk.constructed).toEqual([]);

    await client.createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));
    expect(sdk.constructed).toEqual([[URL_, API_KEY, API_SECRET]]);
  });

  it('calls the lowercase-ip `createSipParticipant`, not `createSIPParticipant`', async () => {
    // The SDK's method is `createSipParticipant`. `createSIPParticipant` is
    // the natural mistyping and would be `undefined` at runtime. The mock
    // class defines ONLY the correct spelling, so a mistyped call throws
    // rather than silently recording nothing.
    const proto = Object.getPrototypeOf(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new ((await import('livekit-server-sdk')) as any).SipClient(URL_, API_KEY, API_SECRET),
    ) as object;
    const methods = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(methods).toContain('createSipParticipant');
    expect(methods).not.toContain('createSIPParticipant');
    sdk.constructed.length = 0;

    await createLiveSipClient(URL_, API_KEY, API_SECRET)
      .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));
    expect(sdk.calls).toHaveLength(1);
  });

  it('passes exactly (trunkId, rawE164, roomName, opts) positionally', async () => {
    await createLiveSipClient(URL_, API_KEY, API_SECRET)
      .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));

    const args = sdk.calls[0];
    // FOUR arguments, in this order. A fifth would mean an option bag split,
    // and a reordering (room before number is the tempting one) would place a
    // call to a room name.
    expect(args).toHaveLength(4);
    expect(args[0]).toBe(TRUNK);
    // The number reaches the SDK RAW and only here — this is the one unwrap.
    expect(args[1]).toBe(RAW_NUMBER);
    expect(typeof args[1]).toBe('string');
    expect(args[2]).toBe(ROOM);
    expect(typeof args[3]).toBe('object');
  });

  it('sets the identity, hides the number, and waits until answered', async () => {
    await createLiveSipClient(URL_, API_KEY, API_SECRET)
      .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));

    const opts = sdk.calls[0][3] as Record<string, unknown>;
    expect(opts.participantIdentity).toBe(`phone-${ATTEMPT}`);
    expect(opts.participantIdentity).toBe(phoneParticipantIdentity(ATTEMPT));
    expect(opts.hidePhoneNumber).toBe(true);
    // 2026-08-29 RCA: a blocking answer-wait timed out under live answered
    // calls (this trunk never delivers the answered notification to the
    // waiting client) and the server deleted the room mid-conversation.
    // The originate must NEVER block on the answer.
    expect(opts.waitUntilAnswered).toBe(false);
  });

  it('sets all three time bounds explicitly, as integers, in SECONDS', async () => {
    await createLiveSipClient(URL_, API_KEY, API_SECRET)
      .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));

    const opts = sdk.calls[0][3] as Record<string, unknown>;

    // PRESENT — an omitted bound is a provider default, and the header of
    // sip.ts explains why each of the three defaults is wrong for us.
    for (const key of ['timeout', 'ringingTimeout', 'maxCallDuration']) {
      expect(Object.prototype.hasOwnProperty.call(opts, key), `${key} is not set`).toBe(true);
      expect(opts[key], `${key} is not a number`).toEqual(expect.any(Number));
      expect(Number.isInteger(opts[key]), `${key} is not an integer`).toBe(true);
    }

    // SECONDS, exactly the configured values.
    expect(opts.timeout).toBe(ORIGINATE_SECONDS);
    // 2026-08-29 (second live kill): the SIP-layer ring timer is DEFUSED —
    // pinned to the max-call bound — because broken server-side answer
    // detection made it tear down consented mid-question calls at the 45s
    // mark. The DOMAIN ring bound (no-answer at ~45s) is owned by the
    // worker's participant-wait; a ringing leg never produces a participant.
    expect(opts.ringingTimeout).toBe(MAX_CALL_SECONDS);
    expect(opts.ringingTimeout).not.toBe(RING_SECONDS);
    expect(opts.maxCallDuration).toBe(MAX_CALL_SECONDS);

    // NOT milliseconds. Stated separately because `toBe(30)` and
    // `not.toBe(30000)` fail for different reasons and a reader of a failure
    // should be able to tell a unit bug from a wiring bug.
    expect(opts.timeout).not.toBe(ORIGINATE_SECONDS * 1000);
    expect(opts.ringingTimeout).not.toBe(MAX_CALL_SECONDS * 1000);
    expect(opts.maxCallDuration).not.toBe(MAX_CALL_SECONDS * 1000);

    // And each equals what the LOADER produced, not a literal typed twice.
    expect(opts.timeout).toBe(dialConfig().originateTimeoutSeconds);
    expect(opts.ringingTimeout).toBe(dialConfig().maxCallSeconds);
    expect(opts.maxCallDuration).toBe(dialConfig().maxCallSeconds);
  });

  it('negative control: the argument matcher bites when the shape changes', () => {
    // The assertions above read positions out of `sdk.calls[0]`. Prove that
    // reading is load-bearing rather than trivially satisfied: a wrongly
    // ordered call fails the very same checks.
    const wrong: unknown[] = [ROOM, TRUNK, RAW_NUMBER, {}];
    expect(wrong[0]).not.toBe(TRUNK);
    expect(wrong[1]).not.toBe(RAW_NUMBER);
    const msOpts: Record<string, unknown> = { timeout: ORIGINATE_SECONDS * 1000 };
    expect(msOpts.timeout).not.toBe(ORIGINATE_SECONDS);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. EXACTLY ONE PARTICIPANT ATTRIBUTE.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 sip — the participant attributes are one key, by name', () => {
  it('sets exactly one attribute: the allowlisted epoch key, stringified', async () => {
    await createLiveSipClient(URL_, API_KEY, API_SECRET)
      .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));

    const opts = sdk.calls[0][3] as { participantAttributes?: Record<string, string> };
    const attrs = opts.participantAttributes!;
    expect(attrs).toBeDefined();

    // EXACTLY one key. `toEqual` on the whole map would also pass if the key
    // were right and a second key were added with an undefined value, so the
    // key list is asserted on its own first.
    expect(Object.keys(attrs)).toEqual([APPROVED_PARTICIPANT_ATTRIBUTES[0]]);
    expect(Object.keys(attrs)).toHaveLength(1);
    expect(attrs[APPROVED_PARTICIPANT_ATTRIBUTES[0]]).toBe(String(EPOCH));
    expect(attrs[APPROVED_PARTICIPANT_ATTRIBUTES[0]]).toBe('7');
    expect(typeof attrs[APPROVED_PARTICIPANT_ATTRIBUTES[0]]).toBe('string');

    // And nothing SIP-shaped rode along. LiveKit populates `sip.phoneNumber`
    // and friends on the participant automatically; setting any of them
    // ourselves would put the subscriber's number in the room deliberately.
    for (const key of Object.keys(attrs)) expect(key.startsWith('sip.')).toBe(false);
    expect(JSON.stringify(attrs)).not.toContain('9876543210');
  });

  it('negative control: a two-key map fails the same assertion', () => {
    const twoKeys = { phone_epoch: '7', 'sip.phoneNumber': RAW_NUMBER };
    expect(Object.keys(twoKeys)).not.toEqual([APPROVED_PARTICIPANT_ATTRIBUTES[0]]);
    expect(Object.keys(twoKeys).some((k) => k.startsWith('sip.'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. THE JOINT CROSS-PHASE CONTRACT (P3 ingress ↔ P5 dialer).
// ═══════════════════════════════════════════════════════════════════════

describe('P5 sip — the epoch attribute is ONE name shared by both lanes', () => {
  it('PHONE_EPOCH_ATTRIBUTE === APPROVED_PARTICIPANT_ATTRIBUTES[0] === phone_epoch', () => {
    // WHY THIS IS A JOINT TEST, AND WHY IT MATTERS MORE THAN IT LOOKS:
    //
    // The dialer WRITES this attribute; P3's ingress READS it, indexing an
    // allowlist by exact name. If the two names ever diverge, the reader finds
    // nothing — and 0042 COALESCES A MISSING EPOCH TO THE ATTEMPT'S OWN. So a
    // rename does not fail: it degrades fencing to "always current", silently,
    // and the first symptom is a stale webhook applying to an attempt that had
    // already moved on. Nothing throws, no test of either lane alone fails.
    //
    // Hence: one constant, INDEXED out of the allowlist rather than copied,
    // and asserted here against the literal so a rename in either lane must be
    // a deliberate, visible, two-sided change.
    expect(PHONE_EPOCH_ATTRIBUTE).toBe(APPROVED_PARTICIPANT_ATTRIBUTES[0]);
    expect(PHONE_EPOCH_ATTRIBUTE).toBe('phone_epoch');
    expect(APPROVED_PARTICIPANT_ATTRIBUTES[0]).toBe('phone_epoch');
    // Exactly one approved attribute. A second entry would mean the ingress
    // reader admits something the dialer never set — the widening this
    // allowlist exists to prevent.
    expect(APPROVED_PARTICIPANT_ATTRIBUTES).toHaveLength(1);
    expect([...APPROVED_PARTICIPANT_ATTRIBUTES]).toEqual(['phone_epoch']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. NOTHING OF THE PROVIDER COMES BACK.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 sip — no number and no provider payload crosses back out', () => {
  it('returns exactly three fields and no SDK object', async () => {
    // The mock answers with a payload shaped like a real `SIPParticipantInfo`
    // PLUS the fields we most fear: the dialled number under several names.
    sdk.result = {
      sipCallId: 'SCL_9f8e7d6c',
      participantId: 'PA_internal',
      participantIdentity: 'not-ours',
      roomName: 'not-ours',
      sipTrunkId: TRUNK,
      phoneNumber: RAW_NUMBER,
      toNumber: RAW_NUMBER,
      attributes: { 'sip.phoneNumber': RAW_NUMBER, 'sip.callID': 'X' },
    };
    const res = await createLiveSipClient(URL_, API_KEY, API_SECRET)
      .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));

    expect(Object.keys(res).sort()).toEqual(['participantIdentity', 'sipCallId', 'synthetic']);
    expect(res.participantIdentity).toBe(`phone-${ATTEMPT}`);
    expect(res.sipCallId).toBe('SCL_9f8e7d6c');
    expect(res.synthetic).toBe(false);

    // The whole rendering carries no digits of the number, under any of the
    // three paths a value normally reaches a log line.
    const rendered = `${JSON.stringify(res)}|${String(res)}|${util.inspect(res)}`;
    expect(rendered).not.toContain('9876543210');
    expect(rendered).not.toContain(RAW_NUMBER);
    expect(rendered).not.toContain('sip.phoneNumber');
    // The provider's identity claim is DISCARDED in favour of our own, so a
    // provider that echoed a different identity cannot redirect resolution.
    expect(res.participantIdentity).not.toBe('not-ours');
  });

  it('drops a provider call id that 0042 would refuse rather than passing it on', async () => {
    for (const bad of ['', 'has space', 'x'.repeat(201), '+919876543210', 'semi;colon']) {
      sdk.calls.length = 0;
      sdk.result = { sipCallId: bad };
      const res = await createLiveSipClient(URL_, API_KEY, API_SECRET)
        .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));
      expect(res.sipCallId, `accepted a bad sip call id: ${bad.slice(0, 20)}`).toBeUndefined();
    }
    // Non-vacuity: a well-formed id IS carried, so the loop above is not
    // passing because the field is always dropped.
    sdk.result = { sipCallId: 'SCL_ok-1' };
    const ok = await createLiveSipClient(URL_, API_KEY, API_SECRET)
      .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));
    expect(ok.sipCallId).toBe('SCL_ok-1');
  });

  it('a provider error propagates UNCHANGED — this layer mints no message of its own', async () => {
    // A carrier SDK may well quote the dialled number in its own error text.
    // This module must not COPY that text anywhere, must not wrap it in a new
    // message of its own, and must not attach the number to it. The strongest
    // observable form of "we added nothing" is object identity: the error the
    // caller catches is the very instance the provider threw.
    //
    // Discarding it is the DIAL CONTROLLER's job — `dialPhoneAttempt` catches
    // this and answers `originate_failed` with no error text at all — so the
    // seam's own obligation is only that it contributes nothing.
    const thrown = new Error('carrier rejected +919876543210');
    sdk.error = thrown;

    const client = createLiveSipClient(URL_, API_KEY, API_SECRET);
    const caught = await client
      .createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)))
      .then(() => undefined, (e: unknown) => e);

    expect(caught).toBe(thrown);
    expect((caught as Error).message).toBe('carrier rejected +919876543210');
    // Nothing of ours was bolted on: no extra own-property, no cause chain.
    expect(Object.keys(caught as object)).toEqual([]);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();

    // Negative control: a wrapper that re-threw with its own text WOULD be
    // visible to the identity assertion above.
    const rewrapped = new Error(`originate failed: ${thrown.message}`);
    expect(rewrapped).not.toBe(thrown);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. `DialableNumber` IS STRUCTURALLY UNLOGGABLE.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 dialable-number — every rendering path yields [redacted]', () => {
  const DIGITS = '9876543210';

  it('String(), template literal, JSON.stringify and util.inspect all redact', () => {
    const n = wrapDialableNumber(RAW_NUMBER);

    expect(String(n)).toBe(REDACTED);
    expect(`${n}`).toBe(REDACTED);
    expect('dialing ' + String(n)).toBe(`dialing ${REDACTED}`);
    expect(JSON.stringify({ n })).toBe(`{"n":"${REDACTED}"}`);
    expect(JSON.stringify(n)).toBe(`"${REDACTED}"`);
    expect(util.inspect(n)).toBe(REDACTED);
    // `console.log(obj)` and Node's own error formatting both go through
    // `util.inspect`, including when the value is NESTED — the path a
    // `toString`-only wrapper leaks on.
    expect(util.inspect({ number: n })).not.toContain(DIGITS);
    expect(util.inspect([n], { depth: 5 })).not.toContain(DIGITS);
    expect(JSON.stringify({ deep: { number: n } })).not.toContain(DIGITS);

    // None of the four renderings contains any part of the number.
    for (const rendered of [
      String(n), `${n}`, JSON.stringify({ n }), util.inspect(n), util.inspect({ n }),
    ]) {
      expect(rendered).not.toContain(DIGITS);
      expect(rendered).not.toContain(RAW_NUMBER);
      expect(rendered).not.toContain('+91');
    }
  });

  it('NEGATIVE CONTROL: the same four renderings DO reveal an unwrapped value', () => {
    // Without this, every assertion above would pass just as happily against a
    // matcher that could never find digits in anything.
    const naked = { number: RAW_NUMBER, toString: () => RAW_NUMBER };
    expect(String(naked)).toContain(DIGITS);
    expect(`${naked}`).toContain(DIGITS);
    expect(JSON.stringify({ naked })).toContain(DIGITS);
    expect(util.inspect(naked)).toContain(DIGITS);
  });

  it('only `unwrapDialableNumber` reveals the digits', () => {
    const n = wrapDialableNumber(RAW_NUMBER);
    expect(unwrapDialableNumber(n)).toBe(RAW_NUMBER);
    // The digest is public — it is the form the allowlist and the suppression
    // table speak — and it is not the number.
    expect(n.digest).toMatch(/^[0-9a-f]{64}$/);
    // The fixture digest used to populate the allowlist is this same value.
    expect(n.digest).toBe(NUMBER_DIGEST);
    expect(n.digest).not.toContain(DIGITS);
    // No enumerable own property carries the digits, so a structured logger
    // that walks own keys finds nothing.
    expect(Object.keys(n)).toEqual(['digest', 'toString', 'toJSON']);
    expect(Object.values(n).join('|')).not.toContain(DIGITS);
    // And the value is frozen, so nothing can bolt a readable field onto it.
    expect(Object.isFrozen(n)).toBe(true);
  });

  it('refuses anything outside +91[6-9]XXXXXXXXX with a BARE code', () => {
    const refused = [
      '',
      '   ',
      '+91987654321',            // nine digits after the class
      '+9198765432100',          // eleven
      '+915876543210',           // 5 is outside [6-9]
      '+910876543210',           // leading zero
      '9876543210',              // no country code
      '919876543210',            // country code without the plus
      '+91 9876543210',          // a space
      '+91-9876543210',          // punctuation
      ' +919876543210',          // leading whitespace, not trimmed for us
      '+919876543210 ',
      '+1415555010',             // another country entirely
      '+919876543210x',
      'not-a-number',
      '<script>+919876543210</script>',
    ];

    for (const raw of refused) {
      let err: unknown;
      try {
        wrapDialableNumber(raw);
      } catch (e) {
        err = e;
      }
      expect(err, `accepted ${JSON.stringify(raw)}`).toBeInstanceOf(Error);
      const message = (err as Error).message;
      // A BARE code. Interpolating the offending value into the message is
      // exactly how the number reaches a log — the wrapper would then leak on
      // the one path it exists to close.
      expect(message).toBe('phone_number_not_dialable');
      if (raw.trim() !== '') {
        expect(message, `message quotes the input ${JSON.stringify(raw)}`)
          .not.toContain(raw.trim());
      }
      expect(message).not.toContain(DIGITS);
      expect(message).not.toContain('+91');
    }
  });

  it('refuses a non-string without throwing something else', () => {
    for (const raw of [undefined, null, 42, {}, ['+919876543210']]) {
      expect(() => wrapDialableNumber(raw as unknown as string))
        .toThrowError('phone_number_not_dialable');
    }
  });

  it('negative control: the accept path exists, so the refusal loop is not vacuous', () => {
    // Both ends of the [6-9] class and a middle value are accepted, proving
    // the predicate refuses by SHAPE rather than refusing everything.
    for (const ok of ['+916012345678', '+919876543210', '+917000000000', '+918000000000']) {
      expect(() => wrapDialableNumber(ok)).not.toThrow();
      expect(unwrapDialableNumber(wrapDialableNumber(ok))).toBe(ok);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. THE GATING TABLE. Only ONE combination reaches the SDK.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 sip — resolvePhoneSipClient hands back live for exactly one combination', () => {
  const CREDS = { url: URL_, apiKey: API_KEY, apiSecret: API_SECRET };

  const denied: Array<{
    label: string;
    screening?: NodeJS.ProcessEnv;
    dial?: NodeJS.ProcessEnv;
    creds?: { url: string; apiKey: string; apiSecret: string };
  }> = [
    { label: 'the master switch is off', screening: { PHONE_SCREENING_ENABLED: 'false' } },
    { label: 'the runtime switch is off', screening: { PHONE_RUNTIME_ENABLED: 'false' } },
    { label: "mode is `off`", screening: { PHONE_DIAL_MODE: 'off' } },
    { label: 'mode is unset (reads as `off`)', screening: { PHONE_DIAL_MODE: undefined } },
    { label: "mode is `synthetic`", screening: { PHONE_DIAL_MODE: 'synthetic' } },
    { label: 'mode is a typo (reads as `off`)', screening: { PHONE_DIAL_MODE: 'LIVE!' } },
    {
      label: 'live but the allowlist is empty',
      screening: { PHONE_DIAL_ALLOWLIST: '' },
    },
    {
      label: 'live but the allowlist holds only malformed entries',
      screening: { PHONE_DIAL_ALLOWLIST: '+919876543210,deadbeef' },
    },
    { label: 'live and allowlisted but the trunk is empty', dial: { PHONE_SIP_TRUNK_ID: '' } },
    {
      label: 'live and allowlisted but the trunk is malformed (dropped to empty)',
      dial: { PHONE_SIP_TRUNK_ID: '+919876543210' },
    },
    { label: 'everything armed but the LiveKit url is missing', creds: { ...CREDS, url: '' } },
    { label: 'everything armed but the api key is missing', creds: { ...CREDS, apiKey: '' } },
    { label: 'everything armed but the api secret is missing', creds: { ...CREDS, apiSecret: '' } },
  ];

  for (const c of denied) {
    it(`yields the SYNTHETIC client when ${c.label}`, async () => {
      const resolution = resolvePhoneSipClient(
        screeningConfig(c.screening ?? {}),
        dialConfig(c.dial ?? {}),
        c.creds ?? CREDS,
      );

      expect(resolution.client.mode).toBe('synthetic');
      expect(resolution.reason).toBe('not_live_permitted');

      // And it is a client from which the SDK is UNREACHABLE: exercising it
      // constructs nothing and calls nothing.
      const res = await resolution.client.createSipParticipant(
        originateRequest(wrapDialableNumber(RAW_NUMBER)),
      );
      expect(res.synthetic).toBe(true);
      expect(res.participantIdentity).toBe(`phone-${ATTEMPT}`);
      expect(res.sipCallId).toBeUndefined();
      expect(sdk.constructed, 'the synthetic client constructed a SipClient').toEqual([]);
      expect(sdk.calls, 'the synthetic client reached the SDK').toEqual([]);
    });
  }

  it('yields the LIVE client ONLY for the fully-permitted combination', () => {
    const resolution = resolvePhoneSipClient(screeningConfig(), dialConfig(), CREDS);
    expect(resolution.client.mode).toBe('live');
    expect(resolution.reason).toBeUndefined();
  });

  it('negative control: the denial table would NOT pass against a live client', async () => {
    // Every row above asserts `mode === 'synthetic'`. If `resolvePhoneSipClient`
    // ever returned the live client for one of them, this is the shape the
    // assertion would be comparing against — and it differs.
    const live = createLiveSipClient(URL_, API_KEY, API_SECRET);
    expect(live.mode).not.toBe('synthetic');
    await live.createSipParticipant(originateRequest(wrapDialableNumber(RAW_NUMBER)));
    // ...and reaching the SDK is observable, so the `toEqual([])` witnesses in
    // the table above are not assertions that can never fail.
    expect(sdk.constructed).toHaveLength(1);
    expect(sdk.calls).toHaveLength(1);
  });

  it('the synthetic client is the DEFAULT, and it derives the identity identically', async () => {
    const synthetic = createSyntheticSipClient();
    expect(synthetic.mode).toBe('synthetic');
    const res = await synthetic.createSipParticipant(
      originateRequest(wrapDialableNumber(RAW_NUMBER)),
    );
    // Same identity as the live path, so a synthetic rehearsal exercises the
    // same downstream resolution a webhook will perform.
    expect(res.participantIdentity).toBe(phoneParticipantIdentity(ATTEMPT));
    expect(res.synthetic).toBe(true);
    expect(Object.keys(res).sort()).toEqual(['participantIdentity', 'synthetic']);
    expect(JSON.stringify(res)).not.toContain('9876543210');
    expect(sdk.constructed).toEqual([]);
    expect(sdk.calls).toEqual([]);
  });

  it('honours injected factories, so the selector itself is what is under test', () => {
    const seen: string[] = [];
    const fakeLive = () => {
      seen.push('live');
      return createSyntheticSipClient();
    };
    const fakeSynthetic = () => {
      seen.push('synthetic');
      return createSyntheticSipClient();
    };

    resolvePhoneSipClient(screeningConfig(), dialConfig(), CREDS, {
      live: fakeLive,
      synthetic: fakeSynthetic,
    });
    expect(seen).toEqual(['live']);

    resolvePhoneSipClient(screeningConfig({ PHONE_DIAL_MODE: 'synthetic' }), dialConfig(), CREDS, {
      live: fakeLive,
      synthetic: fakeSynthetic,
    });
    expect(seen).toEqual(['live', 'synthetic']);
  });
});
