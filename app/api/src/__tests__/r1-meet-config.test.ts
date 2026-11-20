/**
 * R1-over-Meet configuration (M034 S01): dark by default, strict flag, knobs validated, derived
 * URLs on the first WEB_ORIGIN entry, required values present then well formed, credentials hidden,
 * one log line per fixed reason that never carries a value, and never a throw.
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
const CALENDLY_TOKEN_VALUE = 'calendly-canary-' + 't'.repeat(24);
const CALENDLY_SIGNING_VALUE = 'calendly-signing-' + 's'.repeat(20);
const EVENT_TYPE_ID = 'EVTCANARY-0001';
const EVENT_TYPE_URI = `https://api.calendly.com/event_types/${EVENT_TYPE_ID}`;
const WEB = 'https://hello.example.test';
const GROUP_ID = '7d3c2b1a-0f9e-4d8c-9b7a-6f5e4d3c2b1a';

const valid = (extra: R1MeetEnvSource = {}): R1MeetEnvSource => ({
  R1_MEET_ENABLED: 'true',
  RECALL_API_KEY: RECALL_KEY_VALUE,
  RECALL_WEBHOOK_SECRET: RECALL_WEBHOOK_VALUE,
  CALENDLY_API_TOKEN: CALENDLY_TOKEN_VALUE,
  CALENDLY_WEBHOOK_SIGNING_KEY: CALENDLY_SIGNING_VALUE,
  CALENDLY_R1_EVENT_TYPE_URI: EVENT_TYPE_URI,
  WEB_ORIGIN: WEB,
  ...extra,
});

const FLAG_REASON = 'R1_MEET_ENABLED must be either "true" or "false"';
const CAP_REASON = 'R1_MEET_DAILY_BOT_CAP must be an integer from 1 to 200';
const NAME_REASON = 'R1_MEET_BOT_NAME must be 1 to 100 characters with no control characters and no surrounding spaces';
const GROUP_REASON = 'R1_MEET_GOOGLE_LOGIN_GROUP_ID must be a UUID';
const BASE_URL_REASON = 'RECALL_BASE_URL must be an https origin on a <region>.recall.ai host, with no path, port or query';
const ORIGIN_REASON = 'WEB_ORIGIN must start with an https origin (no path, query or credentials) when R1_MEET_ENABLED is "true"';
const missingReason = (name: string): string => `${name} is required when R1_MEET_ENABLED is "true"`;
const MALFORMED_REASON: Record<(typeof R1_MEET_REQUIRED_VARIABLES)[number], string> = {
  RECALL_API_KEY: 'RECALL_API_KEY is malformed',
  RECALL_WEBHOOK_SECRET: 'RECALL_WEBHOOK_SECRET is malformed (expected the whsec_-prefixed workspace verification secret)',
  CALENDLY_API_TOKEN: 'CALENDLY_API_TOKEN is malformed',
  CALENDLY_WEBHOOK_SIGNING_KEY: 'CALENDLY_WEBHOOK_SIGNING_KEY is malformed',
  CALENDLY_R1_EVENT_TYPE_URI: 'CALENDLY_R1_EVENT_TYPE_URI must be https://api.calendly.com/event_types/<id>',
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
      RECALL_BASE_URL: 'http://evil.example',
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
    expect(config.calendly.r1EventTypeUri).toBe(EVENT_TYPE_URI);
    expect(config.botNameOverride).toBeNull();
    expect(config.dailyBotCap).toBe(20);
    expect(config.bridgePageUrl).toBe('https://hello.example.test/candidate/r1/meet');
    expect(config.recallRealtimeWebhookUrl).toBe('https://hello.example.test/api/integrations/recall/realtime');
    // The credentials are readable by name.
    expect(config.recall.apiKey).toBe(RECALL_KEY_VALUE);
    expect(config.recall.webhookSecret).toBe(RECALL_WEBHOOK_VALUE);
    expect(config.calendly.apiToken).toBe(CALENDLY_TOKEN_VALUE);
    expect(config.calendly.webhookSigningKey).toBe(CALENDLY_SIGNING_VALUE);
    expect(logged).toEqual([]);
  });

  it('pins the constants later slices build on', () => {
    expect(R1_MEET_BRIDGE_PAGE_PATH).toBe('/candidate/r1/meet');
    expect(R1_MEET_RECALL_REALTIME_PATH).toBe('/api/integrations/recall/realtime');
    expect([R1_MEET_DAILY_BOT_CAP_DEFAULT, R1_MEET_DAILY_BOT_CAP_MIN, R1_MEET_DAILY_BOT_CAP_MAX]).toEqual([20, 1, 200]);
    expect(R1_MEET_BOT_NAME_MAX_LENGTH).toBe(100);
    expect(R1_MEET_REQUIRED_VARIABLES).toEqual([
      'RECALL_API_KEY',
      'RECALL_WEBHOOK_SECRET',
      'CALENDLY_API_TOKEN',
      'CALENDLY_WEBHOOK_SIGNING_KEY',
      'CALENDLY_R1_EVENT_TYPE_URI',
    ]);
    expect(R1_MEET_SECRET_VARIABLES).toEqual(['RECALL_API_KEY', 'RECALL_WEBHOOK_SECRET', 'CALENDLY_API_TOKEN', 'CALENDLY_WEBHOOK_SIGNING_KEY']);
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
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', RECALL_BASE_URL: 'http://x.recall.ai' }), BASE_URL_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true' }), ORIGIN_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', WEB_ORIGIN: WEB }), missingReason('RECALL_API_KEY'));
    // Within the knobs: cap, then bot name, then group id, then base URL.
    expectInvalid(
      getR1MeetConfig(valid({ R1_MEET_DAILY_BOT_CAP: '0', R1_MEET_BOT_NAME: ' x', R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'x', RECALL_BASE_URL: 'x' })),
      CAP_REASON,
    );
    expectInvalid(getR1MeetConfig(valid({ R1_MEET_BOT_NAME: ' x', R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'x', RECALL_BASE_URL: 'x' })), NAME_REASON);
    expectInvalid(getR1MeetConfig(valid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'x', RECALL_BASE_URL: 'x' })), GROUP_REASON);
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

  it('treats the placeholder as a real (malformed) value outside the four credential slots', () => {
    expectInvalid(getR1MeetConfig(valid({ CALENDLY_R1_EVENT_TYPE_URI: 'replace_me' })), MALFORMED_REASON.CALENDLY_R1_EVENT_TYPE_URI);
  });

  it('checks presence of all five, in order, before checking any of them is well formed', () => {
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', WEB_ORIGIN: WEB }), missingReason('RECALL_API_KEY'));
    expectInvalid(
      getR1MeetConfig(valid({ RECALL_WEBHOOK_SECRET: undefined, CALENDLY_R1_EVENT_TYPE_URI: undefined })),
      missingReason('RECALL_WEBHOOK_SECRET'),
    );
    expectInvalid(
      getR1MeetConfig(valid({ RECALL_API_KEY: 'short', CALENDLY_WEBHOOK_SIGNING_KEY: '' })),
      missingReason('CALENDLY_WEBHOOK_SIGNING_KEY'),
    );
    expectInvalid(
      getR1MeetConfig(valid({ RECALL_WEBHOOK_SECRET: 'nope', CALENDLY_API_TOKEN: 'short' })),
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
    CALENDLY_API_TOKEN: ['t'.repeat(19), `token with space ${'t'.repeat(20)}`, `${'t'.repeat(20)}\r\n`, 't'.repeat(4097), {}],
    CALENDLY_WEBHOOK_SIGNING_KEY: ['s'.repeat(15), `\t${'s'.repeat(20)}`, 's'.repeat(257), `${'s'.repeat(10)} ${'s'.repeat(10)}`, []],
    CALENDLY_R1_EVENT_TYPE_URI: [
      'https://api.calendly.com/event_types/',
      `https://api.calendly.com/event_types/${EVENT_TYPE_ID}/`,
      `https://api.calendly.com/event_types/${EVENT_TYPE_ID}?x=1`,
      `https://api.calendly.com/users/${EVENT_TYPE_ID}`,
      `http://api.calendly.com/event_types/${EVENT_TYPE_ID}`,
      `https://calendly.com/event_types/${EVENT_TYPE_ID}`,
      `https://api.calendly.com.evil.example/event_types/${EVENT_TYPE_ID}`,
      EVENT_TYPE_ID,
      7,
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
  const SECRET_VALUES = [RECALL_KEY_VALUE, RECALL_WEBHOOK_VALUE, CALENDLY_TOKEN_VALUE, CALENDLY_SIGNING_VALUE];

  it('keeps every credential out of every enumeration of the config', () => {
    const config = enabled(getR1MeetConfig(valid()));
    const text = [
      JSON.stringify(config),
      JSON.stringify(config.recall),
      JSON.stringify(config.calendly),
      JSON.stringify({ ...config }),
      JSON.stringify({ ...config.recall }),
      JSON.stringify({ ...config.calendly }),
      JSON.stringify(Object.entries(config.recall)),
      JSON.stringify(Object.values(config.calendly)),
      Object.keys(config.recall).join(','),
      Object.keys(config.calendly).join(','),
      JSON.stringify(describeR1MeetConfig(config)),
    ].join('\n');
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
    expect(Object.keys(config.recall).sort()).toEqual(['baseUrl', 'googleLoginGroupId']);
    expect(Object.keys(config.calendly)).toEqual(['r1EventTypeUri']);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.recall)).toBe(true);
    expect(Object.isFrozen(config.calendly)).toBe(true);
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
      valid({ RECALL_BASE_URL: `https://${CANARY_HOST}` }),
      valid({ WEB_ORIGIN: `http://${CANARY_HOST}` }),
      valid({ RECALL_API_KEY: `${RECALL_KEY_VALUE} ` }),
      valid({ RECALL_WEBHOOK_SECRET: RECALL_WEBHOOK_VALUE.slice(PREFIX.length) }),
      valid({ CALENDLY_API_TOKEN: `${CALENDLY_TOKEN_VALUE}\n` }),
      valid({ CALENDLY_WEBHOOK_SIGNING_KEY: `${CALENDLY_SIGNING_VALUE} x` }),
      valid({ CALENDLY_R1_EVENT_TYPE_URI: `${EVENT_TYPE_URI}/` }),
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
      CANARY_HOST,
      EVENT_TYPE_ID,
      'recall-canary',
      'calendly-canary',
      'calendly-signing',
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
    RECALL_BASE_URL: 'https://us-east-1.recall.ai',
    RECALL_API_KEY: RECALL_KEY_VALUE,
    RECALL_WEBHOOK_SECRET: RECALL_WEBHOOK_VALUE,
    CALENDLY_API_TOKEN: CALENDLY_TOKEN_VALUE,
    CALENDLY_WEBHOOK_SIGNING_KEY: CALENDLY_SIGNING_VALUE,
    CALENDLY_R1_EVENT_TYPE_URI: EVENT_TYPE_URI,
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
    expect(config.calendly.apiToken).toBe(CALENDLY_TOKEN_VALUE);
    expect(config.calendly.webhookSigningKey).toBe(CALENDLY_SIGNING_VALUE);
    expect(config.calendly.r1EventTypeUri).toBe(EVENT_TYPE_URI);
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
    ['RECALL_BASE_URL', 'https://evil.example', BASE_URL_REASON],
    ['WEB_ORIGIN', 'http://hello.example.test', ORIGIN_REASON],
    ['RECALL_API_KEY', 'short', MALFORMED_REASON.RECALL_API_KEY],
    ['RECALL_WEBHOOK_SECRET', 'nope', MALFORMED_REASON.RECALL_WEBHOOK_SECRET],
    ['CALENDLY_API_TOKEN', 'short', MALFORMED_REASON.CALENDLY_API_TOKEN],
    ['CALENDLY_WEBHOOK_SIGNING_KEY', 'short', MALFORMED_REASON.CALENDLY_WEBHOOK_SIGNING_KEY],
    ['CALENDLY_R1_EVENT_TYPE_URI', 'nope', MALFORMED_REASON.CALENDLY_R1_EVENT_TYPE_URI],
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
    const text = JSON.stringify(describeR1MeetConfig(getR1MeetConfig(valid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID }))));
    for (const forbidden of [RECALL_KEY_VALUE, CALENDLY_TOKEN_VALUE, 'https://', GROUP_ID, EVENT_TYPE_ID]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('R1 Meet configuration: env contract', () => {
  const schema = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../../config/environment.schema.json', import.meta.url)), 'utf8'),
  ) as { components: { api: { variables: Record<string, { requiredInProduction: boolean; secret: boolean; external?: boolean }> } } };
  const example = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');

  it('lists exactly the ten Meet variables: non-secrets first, then the four credentials', () => {
    expect([...R1_MEET_ENV_VARIABLES]).toEqual([
      'R1_MEET_ENABLED',
      'R1_MEET_BOT_NAME',
      'R1_MEET_DAILY_BOT_CAP',
      'R1_MEET_GOOGLE_LOGIN_GROUP_ID',
      'RECALL_BASE_URL',
      'CALENDLY_R1_EVENT_TYPE_URI',
      'RECALL_API_KEY',
      'RECALL_WEBHOOK_SECRET',
      'CALENDLY_API_TOKEN',
      'CALENDLY_WEBHOOK_SIGNING_KEY',
    ]);
  });

  it('declares each in the api schema: optional, secret exactly for the four credentials, never external', () => {
    const secrets = new Set<string>(R1_MEET_SECRET_VARIABLES);
    for (const name of R1_MEET_ENV_VARIABLES) {
      const entry = schema.components.api.variables[name];
      expect(entry, name).toBeDefined();
      expect(entry, name).toEqual({ requiredInProduction: false, secret: secrets.has(name) });
    }
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
