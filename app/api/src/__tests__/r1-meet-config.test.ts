/**
 * R1-over-Meet configuration (M034 S01): dark by default, strict flag, knobs validated, derived
 * URLs on the first WEB_ORIGIN entry, required values present then well formed, credentials hidden,
 * one log line per fixed reason that never carries a value, and never a throw.
 *
 * Booking source = Ashby interview schedules with "Dex (AI Interviewer)" as interviewer
 * (D-M034-11): the Dex Ashby user id is required, a fallback service user is optional.
 *
 * Fixture credentials are low-entropy or built at run time: no `whsec_`-prefixed base64 ever
 * appears as a literal in this file (gitleaks scans the full PR history).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  R1_MEET_BOT_NAME_MAX_LENGTH,
  R1_MEET_BRIDGE_PAGE_PATH,
  R1_MEET_DAILY_BOT_CAP_DEFAULT,
  R1_MEET_DAILY_BOT_CAP_MAX,
  R1_MEET_DAILY_BOT_CAP_MIN,
  R1_MEET_ENV_VARIABLES,
  R1_MEET_RECALL_REALTIME_PATH,
  R1_MEET_REQUIRED_VARIABLES,
  R1_MEET_SECRET_VARIABLES,
  describeR1MeetConfig,
  getR1MeetConfig,
  r1MeetActive,
  resetR1MeetConfigReport,
  type R1MeetConfig,
  type R1MeetEnvSource,
} from '../lib/r1/meet/config.js';
import { RECALL_DEFAULT_BASE_URL } from '../integrations/recall/settings.js';

const PREFIX = 'whsec' + '_';
function runtimeWebhookSecret(bytes = 32): string {
  return PREFIX + randomBytes(bytes).toString('base64');
}

// Distinctive (canary) but low-entropy fixture values, so a leak into a log line or an enumeration
// is easy to spot.
const RECALL_KEY_VALUE = 'recall-canary-' + 'k'.repeat(20);
const RECALL_WEBHOOK_VALUE = runtimeWebhookSecret();
const WEB = 'https://hello.example.test';
const GROUP_ID = '7d3c2b1a-0f9e-4d8c-9b7a-6f5e4d3c2b1a';
/** Synthetic Ashby user id of "Dex (AI Interviewer)". */
const DEX_ID = '5e1d0c9b-8a7f-4e6d-9c5b-4a3f2e1d0c9b';
/** Synthetic staff (auth) user id for the optional fallback owner. */
const SERVICE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** The Ashby integration's system actor (integrations/ashby/workflow-stores.ts): no auth.users row. */
const ASHBY_SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000001';
/** The removed booking vendor's name, built so this file never spells it (the slice greps it out). */
const OLD_BOOKING_VENDOR = 'calen' + 'dly';

const valid = (extra: R1MeetEnvSource = {}): R1MeetEnvSource => ({
  R1_MEET_ENABLED: 'true',
  RECALL_API_KEY: RECALL_KEY_VALUE,
  RECALL_WEBHOOK_SECRET: RECALL_WEBHOOK_VALUE,
  R1_MEET_ASHBY_DEX_USER_ID: DEX_ID,
  WEB_ORIGIN: WEB,
  ...extra,
});

const FLAG_REASON = 'R1_MEET_ENABLED must be either "true" or "false"';
const CAP_REASON = 'R1_MEET_DAILY_BOT_CAP must be an integer from 1 to 200';
const NAME_REASON = 'R1_MEET_BOT_NAME must be 1 to 100 characters with no control characters and no surrounding spaces';
const GROUP_REASON = 'R1_MEET_GOOGLE_LOGIN_GROUP_ID must be a UUID';
const SERVICE_REASON = 'R1_MEET_SERVICE_USER_ID must be the UUID of a real staff user (not the nil or system-actor id)';
const BASE_URL_REASON = 'RECALL_BASE_URL must be an https origin on a <region>.recall.ai host, with no path, port or query';
const ORIGIN_REASON = 'WEB_ORIGIN must start with an https origin (no path, query or credentials) when R1_MEET_ENABLED is "true"';
const missingReason = (name: string): string => `${name} is required when R1_MEET_ENABLED is "true"`;
const MALFORMED_REASON: Record<(typeof R1_MEET_REQUIRED_VARIABLES)[number], string> = {
  RECALL_API_KEY: 'RECALL_API_KEY is malformed',
  RECALL_WEBHOOK_SECRET: 'RECALL_WEBHOOK_SECRET is malformed (expected the whsec_-prefixed workspace verification secret)',
  R1_MEET_ASHBY_DEX_USER_ID: 'R1_MEET_ASHBY_DEX_USER_ID must be a UUID (the Ashby user id of "Dex (AI Interviewer)")',
};
const UNEXPECTED_REASON = 'unexpected error while reading the Meet configuration';

let logged: string[];
beforeEach(() => {
  resetR1MeetConfigReport();
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function enabled(config: R1MeetConfig) {
  if (!config.enabled) throw new Error(`expected enabled, got ${config.status}`);
  return config;
}

function expectInvalid(config: R1MeetConfig, reason: string, label?: string): void {
  expect(config, label).toEqual({ enabled: false, status: 'invalid', reason });
}

describe('R1 Meet configuration: the flag', () => {
  it('is disabled (and silent) when the flag is unset, blank or "false", even with every value set', () => {
    expect(getR1MeetConfig({})).toEqual({ enabled: false, status: 'disabled' });
    for (const flag of [undefined, '', 'false']) {
      expect(getR1MeetConfig(valid({ R1_MEET_ENABLED: flag })), String(flag)).toEqual({ enabled: false, status: 'disabled' });
    }
    expect(logged).toEqual([]);
  });

  it('inspects nothing else while disabled: malformed knobs, origin and secrets stay silent', () => {
    const broken: R1MeetEnvSource = {
      R1_MEET_ENABLED: 'false',
      R1_MEET_DAILY_BOT_CAP: '0',
      R1_MEET_BOT_NAME: ' padded ',
      R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'nope',
      R1_MEET_SERVICE_USER_ID: NIL_UUID,
      RECALL_BASE_URL: 'http://evil.example',
      R1_MEET_ASHBY_DEX_USER_ID: 'nope',
      RECALL_API_KEY: 'short',
      RECALL_WEBHOOK_SECRET: 'nope',
      WEB_ORIGIN: 'http://localhost:5173',
    };
    expect(getR1MeetConfig(broken)).toEqual({ enabled: false, status: 'disabled' });
    expect(getR1MeetConfig({ ...broken, R1_MEET_ENABLED: undefined })).toEqual({ enabled: false, status: 'disabled' });
    expect(logged).toEqual([]);
  });

  it('is invalid for any other flag value, with one log line naming R1_MEET_ENABLED', () => {
    const values = ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'False', 'FALSE', '0', 'off', 'enabled'];
    for (const flag of values) expectInvalid(getR1MeetConfig(valid({ R1_MEET_ENABLED: flag })), FLAG_REASON, flag);
    expect(logged).toEqual([`[r1-meet-config] Meet off: ${FLAG_REASON}`]);
    // A non-string flag (a misbehaving source) is invalid too, never enabled.
    for (const flag of [true, 1, {}, null] as unknown[]) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_ENABLED: flag as string })), FLAG_REASON, String(flag));
    }
  });
});

describe('R1 Meet configuration: enabled', () => {
  it('returns the documented defaults and the derived URLs on the first WEB_ORIGIN entry', () => {
    const config = enabled(getR1MeetConfig(valid()));
    expect(config.status).toBe('enabled');
    expect(config.recall.baseUrl).toBe(RECALL_DEFAULT_BASE_URL);
    expect(RECALL_DEFAULT_BASE_URL).toBe('https://ap-northeast-1.recall.ai');
    expect(config.recall.googleLoginGroupId).toBeNull();
    expect(config.ashby).toStrictEqual({ dexUserId: DEX_ID });
    expect(config.serviceUserId).toBeNull();
    expect(config.botNameOverride).toBeNull();
    expect(config.dailyBotCap).toBe(20);
    expect(config.bridgePageUrl).toBe('https://hello.example.test/candidate/r1/meet');
    expect(config.recallRealtimeWebhookUrl).toBe('https://hello.example.test/api/integrations/recall/realtime');
    // The credentials are readable by name.
    expect(config.recall.apiKey).toBe(RECALL_KEY_VALUE);
    expect(config.recall.webhookSecret).toBe(RECALL_WEBHOOK_VALUE);
    expect(logged).toEqual([]);
  });

  it('has exactly the documented enabled shape (Ashby/Dex booking, no booking-vendor settings)', () => {
    const config = enabled(getR1MeetConfig(valid({ R1_MEET_SERVICE_USER_ID: SERVICE_ID })));
    expect(Object.keys(config).sort()).toEqual([
      'ashby',
      'botNameOverride',
      'bridgePageUrl',
      'dailyBotCap',
      'enabled',
      'recall',
      'recallRealtimeWebhookUrl',
      'serviceUserId',
      'status',
    ]);
    expect(Object.keys(config.ashby)).toEqual(['dexUserId']);
    expect(config.serviceUserId).toBe(SERVICE_ID);
    expect(Object.isFrozen(config.ashby)).toBe(true);
    expect(JSON.stringify(config).toLowerCase()).not.toContain(OLD_BOOKING_VENDOR);
  });

  it('lower-cases the Dex Ashby user id (Ashby ids compare case-insensitively)', () => {
    const config = enabled(getR1MeetConfig(valid({ R1_MEET_ASHBY_DEX_USER_ID: DEX_ID.toUpperCase() })));
    expect(config.ashby.dexUserId).toBe(DEX_ID);
  });

  it('pins the constants later slices build on', () => {
    expect(R1_MEET_BRIDGE_PAGE_PATH).toBe('/candidate/r1/meet');
    expect(R1_MEET_RECALL_REALTIME_PATH).toBe('/api/integrations/recall/realtime');
    expect([R1_MEET_DAILY_BOT_CAP_DEFAULT, R1_MEET_DAILY_BOT_CAP_MIN, R1_MEET_DAILY_BOT_CAP_MAX]).toEqual([20, 1, 200]);
    expect(R1_MEET_BOT_NAME_MAX_LENGTH).toBe(100);
    expect(R1_MEET_REQUIRED_VARIABLES).toEqual(['RECALL_API_KEY', 'RECALL_WEBHOOK_SECRET', 'R1_MEET_ASHBY_DEX_USER_ID']);
    expect(R1_MEET_SECRET_VARIABLES).toEqual(['RECALL_API_KEY', 'RECALL_WEBHOOK_SECRET']);
  });

  it.each([
    ['a comma list (first entry wins)', 'https://hello.example.test,https://other.example.test'],
    ['a comma list with spaces', ' https://hello.example.test , http://localhost:5173'],
    ['one trailing slash', 'https://hello.example.test/'],
    ['several trailing slashes', 'https://hello.example.test//'],
    ['upper-case host (canonicalised)', 'https://Hello.Example.Test'],
  ])('derives the URLs from %s', (_name, origin) => {
    const config = enabled(getR1MeetConfig(valid({ WEB_ORIGIN: origin })));
    expect(config.bridgePageUrl).toBe(`${WEB}${R1_MEET_BRIDGE_PAGE_PATH}`);
    expect(config.recallRealtimeWebhookUrl).toBe(`${WEB}${R1_MEET_RECALL_REALTIME_PATH}`);
  });

  it('keeps an explicit non-default port as part of the origin', () => {
    const config = enabled(getR1MeetConfig(valid({ WEB_ORIGIN: 'https://hello.example.test:8443' })));
    expect(config.bridgePageUrl).toBe('https://hello.example.test:8443/candidate/r1/meet');
  });

  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['http', 'http://hello.example.test'],
    ['http first, https second', 'http://localhost:5173,https://hello.example.test'],
    ['an empty first entry', ',https://hello.example.test'],
    ['a path', 'https://hello.example.test/app'],
    ['a query', 'https://hello.example.test?x=1'],
    ['a bare query mark', 'https://hello.example.test?'],
    ['a fragment', 'https://hello.example.test#x'],
    ['userinfo', 'https://user:pw@hello.example.test'],
    ['the explicit default port', 'https://hello.example.test:443'],
    ['a scheme without slashes', 'https:hello.example.test'],
    ['not a URL', 'not a url'],
  ])('is invalid when WEB_ORIGIN is %s', (_name, origin) => {
    expectInvalid(getR1MeetConfig(valid({ WEB_ORIGIN: origin })), ORIGIN_REASON);
  });
});

describe('R1 Meet configuration: knobs', () => {
  it('accepts the daily bot cap from 1 to 200 and defaults blank to 20', () => {
    for (const [raw, expected] of [[undefined, 20], ['', 20], ['1', 1], ['37', 37], ['200', 200], ['020', 20]] as const) {
      expect(enabled(getR1MeetConfig(valid({ R1_MEET_DAILY_BOT_CAP: raw }))).dailyBotCap, String(raw)).toBe(expected);
    }
  });

  it('refuses a cap out of range or not plain digits (a cost cap is never clamped)', () => {
    for (const raw of ['0', '201', '20x', '-1', ' 20', '20 ', '1e2', '2.5', '+5', '99999999999999', 'twenty']) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_DAILY_BOT_CAP: raw })), CAP_REASON, raw);
    }
  });

  it('takes a bot name override of 1..100 plain characters, else null', () => {
    expect(enabled(getR1MeetConfig(valid({ R1_MEET_BOT_NAME: '' }))).botNameOverride).toBeNull();
    for (const name of ['Dex', 'Dex (AI interviewer)', 'D', 'x'.repeat(100), 'Dex Ünïcode']) {
      expect(enabled(getR1MeetConfig(valid({ R1_MEET_BOT_NAME: name }))).botNameOverride, name).toBe(name);
    }
  });

  it('refuses a bot name that is too long, padded or carries control / invisible characters', () => {
    for (const name of [
      'x'.repeat(101),
      ' Dex',
      'Dex ',
      '\tDex',
      'Dex\n',
      'De\u0000x',
      'De\u0007x',
      'De\u007fx',
      'De‮x', // bidi override
      'De​x', // zero-width space
      'De x', // line separator
      'De\ud800x', // lone surrogate
    ]) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_BOT_NAME: name })), NAME_REASON, JSON.stringify(name).slice(0, 16));
    }
  });

  it('takes an optional Google login group UUID (normalised to lower case)', () => {
    expect(enabled(getR1MeetConfig(valid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID }))).recall.googleLoginGroupId).toBe(GROUP_ID);
    expect(enabled(getR1MeetConfig(valid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID.toUpperCase() }))).recall.googleLoginGroupId).toBe(GROUP_ID);
    expect(enabled(getR1MeetConfig(valid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: '' }))).recall.googleLoginGroupId).toBeNull();
    for (const raw of ['not-a-uuid', `{${GROUP_ID}}`, GROUP_ID.replace(/-/g, ''), `${GROUP_ID} `, `${GROUP_ID}0`, 'replace_me']) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: raw })), GROUP_REASON, raw);
    }
  });

  it('takes an optional fallback service user UUID (normalised to lower case), blank = no fallback', () => {
    expect(enabled(getR1MeetConfig(valid())).serviceUserId).toBeNull();
    expect(enabled(getR1MeetConfig(valid({ R1_MEET_SERVICE_USER_ID: '' }))).serviceUserId).toBeNull();
    expect(enabled(getR1MeetConfig(valid({ R1_MEET_SERVICE_USER_ID: SERVICE_ID }))).serviceUserId).toBe(SERVICE_ID);
    expect(enabled(getR1MeetConfig(valid({ R1_MEET_SERVICE_USER_ID: SERVICE_ID.toUpperCase() }))).serviceUserId).toBe(SERVICE_ID);
  });

  it('refuses a service user that is not a UUID, the nil UUID or the Ashby system actor', () => {
    for (const raw of [
      'abc',
      'replace_me', // the placeholder rule covers the two credentials only
      NIL_UUID,
      ASHBY_SYSTEM_ACTOR,
      `{${SERVICE_ID}}`,
      SERVICE_ID.replace(/-/g, ''),
      `${SERVICE_ID} `,
      ` ${SERVICE_ID}`,
      `${SERVICE_ID}0`,
    ]) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_SERVICE_USER_ID: raw })), SERVICE_REASON, raw);
    }
    expectInvalid(getR1MeetConfig(valid({ R1_MEET_SERVICE_USER_ID: 7 as unknown as string })), SERVICE_REASON, 'number');
  });

  it('defaults the Recall base URL to Tokyo and accepts another region origin', () => {
    expect(enabled(getR1MeetConfig(valid({ RECALL_BASE_URL: '' }))).recall.baseUrl).toBe(RECALL_DEFAULT_BASE_URL);
    expect(enabled(getR1MeetConfig(valid({ RECALL_BASE_URL: 'https://us-east-1.recall.ai/' }))).recall.baseUrl).toBe('https://us-east-1.recall.ai');
    for (const raw of [
      'http://ap-northeast-1.recall.ai',
      'https://recall.ai',
      'https://a.b.recall.ai',
      'https://evil-recall.ai',
      'https://evil.example',
      'https://ap-northeast-1.recall.ai/api/v1',
      'https://ap-northeast-1.recall.ai:443',
      'https://ap-northeast-1.recall.ai?x=1',
    ]) {
      expectInvalid(getR1MeetConfig(valid({ RECALL_BASE_URL: raw })), BASE_URL_REASON, raw);
    }
  });

  it('checks the knobs first, then WEB_ORIGIN, then the required values', () => {
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_DAILY_BOT_CAP: '0' }), CAP_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_BOT_NAME: ' x' }), NAME_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'x' }), GROUP_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_SERVICE_USER_ID: 'x' }), SERVICE_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', RECALL_BASE_URL: 'http://x.recall.ai' }), BASE_URL_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true' }), ORIGIN_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', WEB_ORIGIN: WEB }), missingReason('RECALL_API_KEY'));
    // Within the knobs: cap, then bot name, then group id, then service user, then base URL.
    const allKnobsBad: R1MeetEnvSource = {
      R1_MEET_DAILY_BOT_CAP: '0',
      R1_MEET_BOT_NAME: ' x',
      R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'x',
      R1_MEET_SERVICE_USER_ID: 'x',
      RECALL_BASE_URL: 'x',
      WEB_ORIGIN: 'http://x',
      R1_MEET_ASHBY_DEX_USER_ID: 'x',
    };
    expectInvalid(getR1MeetConfig(valid(allKnobsBad)), CAP_REASON);
    expectInvalid(getR1MeetConfig(valid({ ...allKnobsBad, R1_MEET_DAILY_BOT_CAP: '' })), NAME_REASON);
    expectInvalid(getR1MeetConfig(valid({ ...allKnobsBad, R1_MEET_DAILY_BOT_CAP: '', R1_MEET_BOT_NAME: '' })), GROUP_REASON);
    expectInvalid(
      getR1MeetConfig(valid({ ...allKnobsBad, R1_MEET_DAILY_BOT_CAP: '', R1_MEET_BOT_NAME: '', R1_MEET_GOOGLE_LOGIN_GROUP_ID: '' })),
      SERVICE_REASON,
    );
    expectInvalid(
      getR1MeetConfig(
        valid({
          ...allKnobsBad,
          R1_MEET_DAILY_BOT_CAP: '',
          R1_MEET_BOT_NAME: '',
          R1_MEET_GOOGLE_LOGIN_GROUP_ID: '',
          R1_MEET_SERVICE_USER_ID: '',
        }),
      ),
      BASE_URL_REASON,
    );
    // Then WEB_ORIGIN before any required value, then presence before shape.
    expectInvalid(getR1MeetConfig(valid({ WEB_ORIGIN: 'http://x', R1_MEET_ASHBY_DEX_USER_ID: '' })), ORIGIN_REASON);
    expectInvalid(getR1MeetConfig(valid({ RECALL_API_KEY: 'short', R1_MEET_ASHBY_DEX_USER_ID: '' })), missingReason('R1_MEET_ASHBY_DEX_USER_ID'));
    expectInvalid(getR1MeetConfig(valid({ R1_MEET_ASHBY_DEX_USER_ID: 'x', RECALL_API_KEY: 'short' })), MALFORMED_REASON.RECALL_API_KEY);
  });
});

describe('R1 Meet configuration: required values', () => {
  it.each([...R1_MEET_REQUIRED_VARIABLES])('is invalid when %s is missing or blank', (name) => {
    const missing = valid();
    delete missing[name];
    expectInvalid(getR1MeetConfig(missing), missingReason(name), `${name} deleted`);
    expectInvalid(getR1MeetConfig(valid({ [name]: '' })), missingReason(name), `${name} blank`);
    expectInvalid(getR1MeetConfig(valid({ [name]: undefined })), missingReason(name), `${name} undefined`);
  });

  it.each([...R1_MEET_SECRET_VARIABLES])('counts the .env.example placeholder in %s as missing', (name) => {
    expectInvalid(getR1MeetConfig(valid({ [name]: 'replace_me' })), missingReason(name));
  });

  it('treats the placeholder as a real (malformed) value outside the two credential slots', () => {
    expectInvalid(getR1MeetConfig(valid({ R1_MEET_ASHBY_DEX_USER_ID: 'replace_me' })), MALFORMED_REASON.R1_MEET_ASHBY_DEX_USER_ID);
    expectInvalid(getR1MeetConfig(valid({ R1_MEET_SERVICE_USER_ID: 'replace_me' })), SERVICE_REASON);
  });

  it('checks presence of all three, in order, before checking any of them is well formed', () => {
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', WEB_ORIGIN: WEB }), missingReason('RECALL_API_KEY'));
    expectInvalid(
      getR1MeetConfig(valid({ RECALL_WEBHOOK_SECRET: undefined, R1_MEET_ASHBY_DEX_USER_ID: undefined })),
      missingReason('RECALL_WEBHOOK_SECRET'),
    );
    expectInvalid(
      getR1MeetConfig(valid({ RECALL_API_KEY: 'short', R1_MEET_ASHBY_DEX_USER_ID: '' })),
      missingReason('R1_MEET_ASHBY_DEX_USER_ID'),
    );
    expectInvalid(
      getR1MeetConfig(valid({ RECALL_WEBHOOK_SECRET: 'nope', R1_MEET_ASHBY_DEX_USER_ID: 'not-a-uuid' })),
      MALFORMED_REASON.RECALL_WEBHOOK_SECRET,
    );
  });

  const malformed: Record<(typeof R1_MEET_REQUIRED_VARIABLES)[number], unknown[]> = {
    RECALL_API_KEY: ['short', 'k'.repeat(257), `has space ${'k'.repeat(20)}`, `${'k'.repeat(20)}\n`, `\t${'k'.repeat(20)}`, 42],
    RECALL_WEBHOOK_SECRET: [
      randomBytes(32).toString('base64'), // no prefix
      `${PREFIX}!!!!${'A'.repeat(40)}`, // not base64
      PREFIX + randomBytes(8).toString('base64'), // too short (< 16 bytes)
      PREFIX + randomBytes(80).toString('base64'), // too long (> 64 bytes)
      PREFIX,
      `x${runtimeWebhookSecret()}`,
      `${runtimeWebhookSecret()} `,
      42,
    ],
    R1_MEET_ASHBY_DEX_USER_ID: [
      'not-a-uuid',
      'abc',
      `{${DEX_ID}}`,
      DEX_ID.replace(/-/g, ''),
      `${DEX_ID} `,
      ` ${DEX_ID}`,
      `${DEX_ID}0`,
      DEX_ID.slice(0, -1),
      `urn:uuid:${DEX_ID}`,
      7,
      {},
    ],
  };

  it.each([...R1_MEET_REQUIRED_VARIABLES])('is invalid when %s is malformed', (name) => {
    for (const raw of malformed[name]) {
      expectInvalid(getR1MeetConfig(valid({ [name]: raw as string })), MALFORMED_REASON[name], `${name} ${typeof raw}`);
    }
  });

  it('accepts webhook secrets of 24 and 64 bytes and unpadded base64', () => {
    for (const secret of [runtimeWebhookSecret(24), runtimeWebhookSecret(64), runtimeWebhookSecret(32).replace(/=+$/, '')]) {
      expect(enabled(getR1MeetConfig(valid({ RECALL_WEBHOOK_SECRET: secret }))).recall.webhookSecret).toBe(secret);
    }
  });
});

describe('R1 Meet configuration: secrecy', () => {
  const SECRET_VALUES = [RECALL_KEY_VALUE, RECALL_WEBHOOK_VALUE];

  it('keeps every credential out of every enumeration of the config', () => {
    const config = enabled(getR1MeetConfig(valid({ R1_MEET_SERVICE_USER_ID: SERVICE_ID })));
    const text = [
      JSON.stringify(config),
      JSON.stringify(config.recall),
      JSON.stringify(config.ashby),
      JSON.stringify({ ...config }),
      JSON.stringify({ ...config.recall }),
      JSON.stringify(Object.entries(config.recall)),
      JSON.stringify(Object.values(config.recall)),
      JSON.stringify(Object.values(config)),
      Object.keys(config.recall).join(','),
      JSON.stringify(describeR1MeetConfig(config)),
    ].join('\n');
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
    expect(text.toLowerCase()).not.toContain(OLD_BOOKING_VENDOR);
    expect(Object.keys(config.recall).sort()).toEqual(['baseUrl', 'googleLoginGroupId']);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.recall)).toBe(true);
    expect(Object.isFrozen(config.ashby)).toBe(true);
    expect(() => {
      (config.recall as { apiKey: string }).apiKey = 'replaced';
    }).toThrow(TypeError);
    expect(config.recall.apiKey).toBe(RECALL_KEY_VALUE);
  });

  it('never logs a value: every line is a fixed reason, whatever was configured', () => {
    const CANARY_NAME = 'CanaryBotName';
    const CANARY_HOST = 'canary-origin.example.test';
    const cases: R1MeetEnvSource[] = [
      valid({ R1_MEET_ENABLED: 'canary-flag' }),
      valid({ R1_MEET_DAILY_BOT_CAP: '987654' }),
      valid({ R1_MEET_BOT_NAME: `${CANARY_NAME}\u0000` }),
      valid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'canary-group-id' }),
      valid({ R1_MEET_SERVICE_USER_ID: 'canary-service-user' }),
      valid({ RECALL_BASE_URL: `https://${CANARY_HOST}` }),
      valid({ WEB_ORIGIN: `http://${CANARY_HOST}` }),
      valid({ RECALL_API_KEY: `${RECALL_KEY_VALUE} ` }),
      valid({ RECALL_WEBHOOK_SECRET: RECALL_WEBHOOK_VALUE.slice(PREFIX.length) }),
      valid({ R1_MEET_ASHBY_DEX_USER_ID: 'canary-dex-user' }),
    ];
    for (const source of cases) expect(getR1MeetConfig(source).status).toBe('invalid');
    expect(logged).toHaveLength(cases.length);
    const canaries = [
      ...SECRET_VALUES,
      RECALL_WEBHOOK_VALUE.slice(PREFIX.length),
      'canary-flag',
      '987654',
      CANARY_NAME,
      'canary-group-id',
      'canary-service-user',
      'canary-dex-user',
      CANARY_HOST,
      'recall-canary',
    ];
    for (const line of logged) {
      expect(line.startsWith('[r1-meet-config] Meet off: ')).toBe(true);
      for (const canary of canaries) expect(line, canary).not.toContain(canary);
    }
  });

  it('logs each reason once across repeated reads, and again after the reset seam', () => {
    for (let i = 0; i < 5; i += 1) getR1MeetConfig(valid({ R1_MEET_DAILY_BOT_CAP: '0' }));
    expect(logged).toEqual([`[r1-meet-config] Meet off: ${CAP_REASON}`]);
    for (let i = 0; i < 3; i += 1) getR1MeetConfig(valid({ RECALL_API_KEY: undefined }));
    expect(logged).toEqual([
      `[r1-meet-config] Meet off: ${CAP_REASON}`,
      `[r1-meet-config] Meet off: ${missingReason('RECALL_API_KEY')}`,
    ]);
    // Enabled and disabled reads log nothing.
    getR1MeetConfig(valid());
    getR1MeetConfig({});
    expect(logged).toHaveLength(2);
    resetR1MeetConfigReport();
    getR1MeetConfig(valid({ R1_MEET_DAILY_BOT_CAP: '0' }));
    expect(logged).toHaveLength(3);
  });

  it('never throws, even when the source itself throws', () => {
    const throwingSecret = valid();
    Object.defineProperty(throwingSecret, 'RECALL_API_KEY', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const throwingFlag = {} as R1MeetEnvSource;
    Object.defineProperty(throwingFlag, 'R1_MEET_ENABLED', {
      get() {
        throw new Error('boom');
      },
    });
    const throwingEverywhere = new Proxy({} as R1MeetEnvSource, {
      get() {
        throw new Error('boom');
      },
    });
    for (const source of [throwingSecret, throwingFlag, throwingEverywhere]) {
      let result: R1MeetConfig | undefined;
      expect(() => {
        result = getR1MeetConfig(source);
      }).not.toThrow();
      expectInvalid(result!, UNEXPECTED_REASON);
    }
    expect(logged).toEqual([`[r1-meet-config] Meet off: ${UNEXPECTED_REASON}`]);
  });
});

describe('R1 Meet configuration: process.env (the production path)', () => {
  const ENV_VALID: Record<string, string> = {
    R1_MEET_ENABLED: 'true',
    R1_MEET_BOT_NAME: 'Dex',
    R1_MEET_DAILY_BOT_CAP: '7',
    R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID,
    R1_MEET_SERVICE_USER_ID: SERVICE_ID,
    RECALL_BASE_URL: 'https://us-east-1.recall.ai',
    R1_MEET_ASHBY_DEX_USER_ID: DEX_ID,
    RECALL_API_KEY: RECALL_KEY_VALUE,
    RECALL_WEBHOOK_SECRET: RECALL_WEBHOOK_VALUE,
    WEB_ORIGIN: WEB,
  };
  function stubAll(overrides: Record<string, string> = {}): void {
    for (const [name, value] of Object.entries({ ...ENV_VALID, ...overrides })) vi.stubEnv(name, value);
  }

  it('reads every variable from process.env when no source is passed', () => {
    stubAll();
    const config = enabled(getR1MeetConfig());
    expect(config.botNameOverride).toBe('Dex');
    expect(config.dailyBotCap).toBe(7);
    expect(config.recall.googleLoginGroupId).toBe(GROUP_ID);
    expect(config.recall.baseUrl).toBe('https://us-east-1.recall.ai');
    expect(config.recall.apiKey).toBe(RECALL_KEY_VALUE);
    expect(config.recall.webhookSecret).toBe(RECALL_WEBHOOK_VALUE);
    expect(config.ashby.dexUserId).toBe(DEX_ID);
    expect(config.serviceUserId).toBe(SERVICE_ID);
    expect(config.bridgePageUrl).toBe(`${WEB}${R1_MEET_BRIDGE_PAGE_PATH}`);
  });

  it('is disabled by default: the flag unset in process.env', () => {
    stubAll({ R1_MEET_ENABLED: '' });
    expect(getR1MeetConfig()).toEqual({ enabled: false, status: 'disabled' });
  });

  it.each([
    ['R1_MEET_ENABLED', 'yes', FLAG_REASON],
    ['R1_MEET_BOT_NAME', ' padded', NAME_REASON],
    ['R1_MEET_DAILY_BOT_CAP', '0', CAP_REASON],
    ['R1_MEET_GOOGLE_LOGIN_GROUP_ID', 'nope', GROUP_REASON],
    ['R1_MEET_SERVICE_USER_ID', ASHBY_SYSTEM_ACTOR, SERVICE_REASON],
    ['RECALL_BASE_URL', 'https://evil.example', BASE_URL_REASON],
    ['WEB_ORIGIN', 'http://hello.example.test', ORIGIN_REASON],
    ['R1_MEET_ASHBY_DEX_USER_ID', 'nope', MALFORMED_REASON.R1_MEET_ASHBY_DEX_USER_ID],
    ['RECALL_API_KEY', 'short', MALFORMED_REASON.RECALL_API_KEY],
    ['RECALL_WEBHOOK_SECRET', 'nope', MALFORMED_REASON.RECALL_WEBHOOK_SECRET],
  ])('reads %s from process.env', (name, bad, reason) => {
    stubAll({ [name]: bad });
    expectInvalid(getR1MeetConfig(), reason);
  });
});

describe('R1 Meet configuration: helpers', () => {
  it('r1MeetActive needs both R1 and Meet enabled', () => {
    const on = getR1MeetConfig(valid());
    const off = getR1MeetConfig({});
    const bad = getR1MeetConfig(valid({ R1_MEET_ENABLED: 'yes' }));
    expect(r1MeetActive({ enabled: true }, on)).toBe(true);
    expect(r1MeetActive({ enabled: false }, on)).toBe(false);
    for (const meet of [off, bad]) {
      expect(r1MeetActive({ enabled: true }, meet)).toBe(false);
      expect(r1MeetActive({ enabled: false }, meet)).toBe(false);
    }
  });

  it('describeR1MeetConfig shows status (and reason) only: no credential, URL or knob', () => {
    expect(describeR1MeetConfig(getR1MeetConfig(valid()))).toEqual({ enabled: true, status: 'enabled' });
    expect(describeR1MeetConfig(getR1MeetConfig({}))).toEqual({ enabled: false, status: 'disabled' });
    expect(describeR1MeetConfig(getR1MeetConfig(valid({ R1_MEET_DAILY_BOT_CAP: '0' })))).toEqual({
      enabled: false,
      status: 'invalid',
      reason: CAP_REASON,
    });
    const text = JSON.stringify(
      describeR1MeetConfig(getR1MeetConfig(valid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID, R1_MEET_SERVICE_USER_ID: SERVICE_ID }))),
    );
    for (const forbidden of [RECALL_KEY_VALUE, 'https://', GROUP_ID, DEX_ID, SERVICE_ID]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('R1 Meet configuration: env contract', () => {
  const schema = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../../config/environment.schema.json', import.meta.url)), 'utf8'),
  ) as { components: { api: { variables: Record<string, { requiredInProduction: boolean; secret: boolean; external?: boolean }> } } };
  const example = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');

  it('lists exactly the nine Meet variables: non-secrets first, then the two credentials', () => {
    expect([...R1_MEET_ENV_VARIABLES]).toEqual([
      'R1_MEET_ENABLED',
      'R1_MEET_BOT_NAME',
      'R1_MEET_DAILY_BOT_CAP',
      'R1_MEET_GOOGLE_LOGIN_GROUP_ID',
      'R1_MEET_SERVICE_USER_ID',
      'RECALL_BASE_URL',
      'R1_MEET_ASHBY_DEX_USER_ID',
      'RECALL_API_KEY',
      'RECALL_WEBHOOK_SECRET',
    ]);
  });

  it('declares each in the api schema: optional, secret exactly for the two Recall credentials, never external', () => {
    const secrets = new Set<string>(R1_MEET_SECRET_VARIABLES);
    expect([...secrets]).toEqual(['RECALL_API_KEY', 'RECALL_WEBHOOK_SECRET']);
    for (const name of R1_MEET_ENV_VARIABLES) {
      const entry = schema.components.api.variables[name];
      expect(entry, name).toBeDefined();
      expect(entry, name).toEqual({ requiredInProduction: false, secret: secrets.has(name) });
    }
  });

  it('declares no other Meet-prefixed or booking-vendor variable in the api schema or .env.example', () => {
    const meetLike = /^(?:R1_MEET|RECALL)_/;
    const schemaNames = Object.keys(schema.components.api.variables);
    expect(schemaNames.filter((name) => meetLike.test(name)).sort()).toEqual([...R1_MEET_ENV_VARIABLES].sort());
    const exampleNames = [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((match) => match[1]!);
    expect(exampleNames.filter((name) => meetLike.test(name)).sort()).toEqual([...R1_MEET_ENV_VARIABLES].sort());
    const vendor = new RegExp(OLD_BOOKING_VENDOR, 'i');
    expect(schemaNames.filter((name) => vendor.test(name))).toEqual([]);
    expect(example).not.toMatch(vendor);
  });

  it('puts each in the api .env.example: blank values, replace_me for the credentials, no example secret', () => {
    const secrets = new Set<string>(R1_MEET_SECRET_VARIABLES);
    const parsed: Record<string, string> = {};
    for (const name of R1_MEET_ENV_VARIABLES) {
      const match = new RegExp(`^${name}=(.*)$`, 'm').exec(example);
      expect(match, name).not.toBeNull();
      expect(match![1], name).toBe(secrets.has(name) ? 'replace_me' : '');
      parsed[name] = match![1]!;
    }
    expect(example).not.toMatch(/whsec_[A-Za-z0-9+/]{8,}/);
    // A copied example file is "disabled", not "half configured".
    expect(getR1MeetConfig(parsed as R1MeetEnvSource)).toEqual({ enabled: false, status: 'disabled' });
    expect(logged).toEqual([]);
  });
});
