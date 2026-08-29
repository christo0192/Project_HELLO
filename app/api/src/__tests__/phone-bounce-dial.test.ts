/**
 * Bounce-mode dialing — config gating and the dial target.
 *
 * The two properties this phase must not get wrong:
 *   1. OFF is byte-identical: the dialer targets the direct trunk with the
 *      candidate number and sets NO correlation attribute.
 *   2. ON re-routes ONLY the transport: the dial targets the BOUNCE trunk and
 *      the bounce endpoint user, carries the `xhelloattempt` attribute, and
 *      the candidate number still passes admission unchanged (it is simply not
 *      what is dialled).
 */

import { describe, it, expect } from 'vitest';
import {
  loadPhoneDialConfig,
  isPhoneTransportReady,
  describePhoneDialConfig,
} from '../integrations/livekit-phone-dial/config.js';
import {
  createLiveSipClient,
  PHONE_HELLO_ATTEMPT_ATTRIBUTE,
  PHONE_HELLO_ATTEMPT_HEADER,
  helloAttemptHeaderValue,
  PHONE_EPOCH_ATTRIBUTE,
  type PhoneOriginateRequest,
} from '../integrations/livekit-phone-dial/sip.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';

const NUMBER = wrapDialableNumber('+919812345678');
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('bounce config — default OFF is byte-identical', () => {
  it('loads bounce OFF by default and transport readiness uses the direct trunk', () => {
    const cfg = loadPhoneDialConfig({ PHONE_SIP_TRUNK_ID: 'direct-trunk' } as NodeJS.ProcessEnv);
    expect(cfg.bounceMode).toBe(false);
    expect(cfg.bounceTrunkId).toBe('');
    expect(cfg.bounceSipUser).toBe('');
    expect(isPhoneTransportReady(cfg)).toBe(true);
  });

  it('only the exact string "true" arms bounce mode', () => {
    for (const v of ['false', '1', 'TRUE', 'yes', '']) {
      expect(loadPhoneDialConfig({ PHONE_BOUNCE_MODE: v } as NodeJS.ProcessEnv).bounceMode).toBe(false);
    }
    expect(loadPhoneDialConfig({ PHONE_BOUNCE_MODE: 'true' } as NodeJS.ProcessEnv).bounceMode).toBe(true);
  });
});

describe('bounce config — ON is fail-closed on the bounce path', () => {
  it('is NOT transport-ready with bounce on but no bounce trunk / user', () => {
    const noTrunk = loadPhoneDialConfig({
      PHONE_BOUNCE_MODE: 'true',
      PHONE_BOUNCE_SIP_USER: 'hello_bounce',
    } as NodeJS.ProcessEnv);
    expect(isPhoneTransportReady(noTrunk)).toBe(false);

    const noUser = loadPhoneDialConfig({
      PHONE_BOUNCE_MODE: 'true',
      PHONE_BOUNCE_TRUNK_ID: 'bounce-trunk',
    } as NodeJS.ProcessEnv);
    expect(isPhoneTransportReady(noUser)).toBe(false);
  });

  it('is transport-ready with bounce on and both bounce fields set — even with NO direct trunk', () => {
    const cfg = loadPhoneDialConfig({
      PHONE_BOUNCE_MODE: 'true',
      PHONE_BOUNCE_TRUNK_ID: 'bounce-trunk',
      PHONE_BOUNCE_SIP_USER: 'hello_bounce',
    } as NodeJS.ProcessEnv);
    expect(cfg.sipTrunkId).toBe('');
    expect(isPhoneTransportReady(cfg)).toBe(true);
  });

  it('the bounce sip user can never hold a number (opaque class drops + and space)', () => {
    const cfg = loadPhoneDialConfig({
      PHONE_BOUNCE_MODE: 'true',
      PHONE_BOUNCE_TRUNK_ID: 'bounce-trunk',
      PHONE_BOUNCE_SIP_USER: '+919812345678',
    } as NodeJS.ProcessEnv);
    expect(cfg.bounceSipUser).toBe('');
  });

  it('the health projection exposes bounce booleans, never the ids', () => {
    const cfg = loadPhoneDialConfig({
      PHONE_BOUNCE_MODE: 'true',
      PHONE_BOUNCE_TRUNK_ID: 'bounce-trunk',
      PHONE_BOUNCE_SIP_USER: 'hello_bounce',
    } as NodeJS.ProcessEnv);
    const d = describePhoneDialConfig(cfg);
    expect(d.bounceMode).toBe(true);
    expect(d.bounceConfigured).toBe(true);
    expect(JSON.stringify(d)).not.toContain('bounce-trunk');
    expect(JSON.stringify(d)).not.toContain('hello_bounce');
  });
});

/**
 * Drive the LIVE client with an injected fake SDK so we can observe the exact
 * arguments it hands `createSipParticipant`, for both target shapes.
 */
async function captureLiveOriginate(request: PhoneOriginateRequest): Promise<{
  sipCallTo: string;
  attributes: Record<string, string>;
  headers: Record<string, string> | undefined;
  trunkId: string;
}> {
  const captured = {
    sipCallTo: '',
    attributes: {} as Record<string, string>,
    headers: undefined as Record<string, string> | undefined,
    trunkId: '',
  };
  // Patch the dynamic import target by monkeypatching the SDK module cache is
  // heavy; instead exercise via the module's own live client with a stub SDK.
  // The live client does `await import('livekit-server-sdk')`, so we intercept
  // by temporarily replacing the global — but simplest is to assert through a
  // recording SipClient injected at the module boundary. Here we call the real
  // createLiveSipClient and rely on the SDK mock installed below.
  const client = createLiveSipClient('ws://x', 'k', 's');
  // The SDK is mocked in this file (see vi.mock at bottom) to record args.
  (globalThis as unknown as { __plivoCapture?: typeof captured }).__plivoCapture = captured;
  await client.createSipParticipant(request);
  return captured;
}

// Mock the SDK so the live client records rather than dials.
import { vi } from 'vitest';
vi.mock('livekit-server-sdk', () => ({
  SipClient: class {
    async createSipParticipant(
      trunkId: string,
      sipCallTo: string,
      _roomName: string,
      opts: { participantAttributes?: Record<string, string>; headers?: Record<string, string> },
    ) {
      const cap = (globalThis as unknown as {
        __plivoCapture?: {
          sipCallTo: string;
          attributes: Record<string, string>;
          headers: Record<string, string> | undefined;
          trunkId: string;
        };
      }).__plivoCapture;
      if (cap) {
        cap.trunkId = trunkId;
        cap.sipCallTo = sipCallTo;
        cap.attributes = opts.participantAttributes ?? {};
        cap.headers = opts.headers;
      }
      return { participantIdentity: `phone-${ATTEMPT}`, sipCallId: 'sc_123' };
    }
  },
}));

const baseRequest = {
  roomName: 'phone-room',
  attemptId: ATTEMPT,
  epoch: 7,
  originateTimeoutSeconds: 60,
  ringTimeoutSeconds: 45,
  maxCallSeconds: 900,
} as const;

describe('bounce dial — the live client targets and attributes', () => {
  it('candidate path: dials the (unwrapped) number, epoch attribute ONLY', async () => {
    const cap = await captureLiveOriginate({
      trunkId: 'direct-trunk',
      target: { kind: 'number', number: NUMBER },
      ...baseRequest,
    });
    expect(cap.trunkId).toBe('direct-trunk');
    expect(cap.sipCallTo).toBe('+919812345678');
    expect(cap.attributes).toEqual({ [PHONE_EPOCH_ATTRIBUTE]: '7' });
    expect(cap.attributes[PHONE_HELLO_ATTEMPT_ATTRIBUTE]).toBeUndefined();
    // No custom INVITE headers on the candidate path — byte-identical to before.
    expect(cap.headers).toBeUndefined();
  });

  it('bounce path: dials the endpoint user and carries xhelloattempt = attemptId', async () => {
    const cap = await captureLiveOriginate({
      trunkId: 'bounce-trunk',
      target: { kind: 'bounce', bounceUser: 'hello_bounce' },
      ...baseRequest,
    });
    expect(cap.trunkId).toBe('bounce-trunk');
    expect(cap.sipCallTo).toBe('hello_bounce');
    expect(cap.attributes[PHONE_EPOCH_ATTRIBUTE]).toBe('7');
    expect(cap.attributes[PHONE_HELLO_ATTEMPT_ATTRIBUTE]).toBe(ATTEMPT);
    // The candidate number never appears on the bounce path.
    expect(cap.sipCallTo).not.toContain('+91');
  });

  it('bounce path: the correlation rides the INVITE as a Plivo-legal header', async () => {
    const cap = await captureLiveOriginate({
      trunkId: 'bounce-trunk',
      target: { kind: 'bounce', bounceUser: 'hello_bounce' },
      ...baseRequest,
    });
    // The trunk attributesToHeaders mapping never touches the INVITE
    // (livekit/sip#404) — the header must be set explicitly, and in the shape
    // Plivo will not silently drop: dash-free name after the X-PH- prefix,
    // dash-free (pure alphanumeric) value.
    expect(cap.headers).toEqual({
      [PHONE_HELLO_ATTEMPT_HEADER]: helloAttemptHeaderValue(ATTEMPT),
    });
    const sent = cap.headers?.[PHONE_HELLO_ATTEMPT_HEADER] ?? '';
    expect(sent).toMatch(/^[0-9a-f]{32}$/);
    expect(sent).toBe(ATTEMPT.replace(/-/g, ''));
    // Plivo name rule: X-PH- prefix, then alphanumerics only, max 24 chars.
    expect(PHONE_HELLO_ATTEMPT_HEADER).toMatch(/^X-PH-[A-Za-z0-9]{1,24}$/);
  });
});
