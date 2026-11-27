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
  R1_MEET_MULTI_HUMAN_POLICIES,
  R1_MEET_MULTI_HUMAN_POLICY_DEFAULT,
  R1_MEET_PUBLIC_ENV_VARIABLES,
  R1_MEET_PUBLIC_SECRET_VARIABLES,
  R1_MEET_RECALL_REALTIME_PATH,
  R1_MEET_REQUIRED_VARIABLES,
  R1_MEET_SECRET_VARIABLES,
  describeR1MeetConfig,
  getR1MeetConfig,
  getR1MeetDrainConfig,
  getR1MeetFeedbackConfig,
  getR1MeetPublicConfig,
  getR1MeetPublicDrainConfig,
  r1MeetActive,
  r1MeetDrainAllowed,
  resetR1MeetConfigReport,
  type R1MeetConfig,
  type R1MeetEnvSource,
  type R1MeetFeedbackConfig,
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
/** Synthetic Ashby feedback form id (M034 S09), in the harness id namespace. */
const FORM_ID = '7f000000-0000-4000-8000-0000000000fb';
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
const ARM_REASON = 'R1_MEET_ARM_AT_CREATE must be either "true" or "false"';
const POLICY_REASON = 'R1_MEET_MULTI_HUMAN_POLICY must be "end" or "observe"';
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
      R1_MEET_ARM_AT_CREATE: 'maybe',
      R1_MEET_MULTI_HUMAN_POLICY: 'nope',
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
    expect(config.armAtCreate).toBe(false);
    expect(config.multiHumanPolicy).toBe('observe');
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
      'armAtCreate',
      'ashby',
      'botNameOverride',
      'bridgePageUrl',
      'dailyBotCap',
      'enabled',
      'multiHumanPolicy',
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
    expect([...R1_MEET_MULTI_HUMAN_POLICIES]).toEqual(['end', 'observe']);
    expect(Object.isFrozen(R1_MEET_MULTI_HUMAN_POLICIES)).toBe(true);
    // S06-R3: `observe` until the live spike settles the bot's own join and HR's admission.
    expect(R1_MEET_MULTI_HUMAN_POLICY_DEFAULT).toBe('observe');
    expect(R1_MEET_REQUIRED_VARIABLES).toEqual(['RECALL_API_KEY', 'RECALL_WEBHOOK_SECRET', 'R1_MEET_ASHBY_DEX_USER_ID']);
    expect(R1_MEET_SECRET_VARIABLES).toEqual(['RECALL_API_KEY', 'RECALL_WEBHOOK_SECRET']);
    // M035: the three Google credentials are secrets too, but never Meet requirements.
    expect(R1_MEET_PUBLIC_SECRET_VARIABLES).toEqual([
      'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET',
      'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN',
      'R1_MEET_GOOGLE_SA_KEY_B64',
    ]);
    for (const name of R1_MEET_PUBLIC_SECRET_VARIABLES) {
      expect(R1_MEET_SECRET_VARIABLES as readonly string[], name).not.toContain(name);
      expect(R1_MEET_REQUIRED_VARIABLES as readonly string[], name).not.toContain(name);
    }
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

  it('arms when a human joins unless R1_MEET_ARM_AT_CREATE is exactly "true"', () => {
    for (const [raw, expected] of [[undefined, false], ['', false], ['false', false], ['true', true]] as const) {
      expect(enabled(getR1MeetConfig(valid({ R1_MEET_ARM_AT_CREATE: raw }))).armAtCreate, String(raw)).toBe(expected);
    }
    for (const raw of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'False', '0', 'off', 'replace_me']) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_ARM_AT_CREATE: raw })), ARM_REASON, raw);
    }
    for (const raw of [true, false, 1, null, {}] as unknown[]) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_ARM_AT_CREATE: raw as string })), ARM_REASON, String(raw));
    }
  });

  it('only logs a second human unless R1_MEET_MULTI_HUMAN_POLICY is exactly "end"', () => {
    for (const [raw, expected] of [[undefined, 'observe'], ['', 'observe'], ['end', 'end'], ['observe', 'observe']] as const) {
      expect(enabled(getR1MeetConfig(valid({ R1_MEET_MULTI_HUMAN_POLICY: raw }))).multiHumanPolicy, String(raw)).toBe(expected);
    }
    for (const raw of ['END', 'Observe', ' end', 'observe ', 'pause', 'true', 'off', 'replace_me']) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_MULTI_HUMAN_POLICY: raw })), POLICY_REASON, raw);
    }
    for (const raw of [true, 1, null, {}, ['end']] as unknown[]) {
      expectInvalid(getR1MeetConfig(valid({ R1_MEET_MULTI_HUMAN_POLICY: raw as string })), POLICY_REASON, String(raw));
    }
  });

  it('checks the knobs first, then WEB_ORIGIN, then the required values', () => {
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_DAILY_BOT_CAP: '0' }), CAP_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_BOT_NAME: ' x' }), NAME_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'x' }), GROUP_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_SERVICE_USER_ID: 'x' }), SERVICE_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', RECALL_BASE_URL: 'http://x.recall.ai' }), BASE_URL_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_ARM_AT_CREATE: 'x' }), ARM_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', R1_MEET_MULTI_HUMAN_POLICY: 'x' }), POLICY_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true' }), ORIGIN_REASON);
    expectInvalid(getR1MeetConfig({ R1_MEET_ENABLED: 'true', WEB_ORIGIN: WEB }), missingReason('RECALL_API_KEY'));
    // Within the knobs: cap, bot name, group id, service user, base URL, arm mode, multi-human policy.
    const allKnobsBad: R1MeetEnvSource = {
      R1_MEET_DAILY_BOT_CAP: '0',
      R1_MEET_BOT_NAME: ' x',
      R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'x',
      R1_MEET_SERVICE_USER_ID: 'x',
      RECALL_BASE_URL: 'x',
      R1_MEET_ARM_AT_CREATE: 'x',
      R1_MEET_MULTI_HUMAN_POLICY: 'x',
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
    const onlySwitchesBad: R1MeetEnvSource = {
      ...allKnobsBad,
      R1_MEET_DAILY_BOT_CAP: '',
      R1_MEET_BOT_NAME: '',
      R1_MEET_GOOGLE_LOGIN_GROUP_ID: '',
      R1_MEET_SERVICE_USER_ID: '',
      RECALL_BASE_URL: '',
    };
    expectInvalid(getR1MeetConfig(valid(onlySwitchesBad)), ARM_REASON);
    expectInvalid(getR1MeetConfig(valid({ ...onlySwitchesBad, R1_MEET_ARM_AT_CREATE: '' })), POLICY_REASON);
    expectInvalid(
      getR1MeetConfig(valid({ ...onlySwitchesBad, R1_MEET_ARM_AT_CREATE: '', R1_MEET_MULTI_HUMAN_POLICY: '' })),
      ORIGIN_REASON,
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
      valid({ R1_MEET_ARM_AT_CREATE: 'canary-arm-mode' }),
      valid({ R1_MEET_MULTI_HUMAN_POLICY: 'canary-policy' }),
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
      'canary-arm-mode',
      'canary-policy',
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
    R1_MEET_ARM_AT_CREATE: 'true',
    R1_MEET_MULTI_HUMAN_POLICY: 'observe',
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
    expect(config.armAtCreate).toBe(true);
    expect(config.multiHumanPolicy).toBe('observe');
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
    ['R1_MEET_ARM_AT_CREATE', 'yes', ARM_REASON],
    ['R1_MEET_MULTI_HUMAN_POLICY', 'pause', POLICY_REASON],
    ['WEB_ORIGIN', 'http://hello.example.test', ORIGIN_REASON],
    ['R1_MEET_ASHBY_DEX_USER_ID', 'nope', MALFORMED_REASON.R1_MEET_ASHBY_DEX_USER_ID],
    ['RECALL_API_KEY', 'short', MALFORMED_REASON.RECALL_API_KEY],
    ['RECALL_WEBHOOK_SECRET', 'nope', MALFORMED_REASON.RECALL_WEBHOOK_SECRET],
    // Deliberately absent: R1_MEET_ASHBY_FEEDBACK_FORM_ID (M034 S09). It can never make Meet invalid:
    // getR1MeetConfig ignores it and getR1MeetFeedbackConfig validates it (its own describe below).
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

describe('R1 Meet configuration: the drain', () => {
  const available = (source: Parameters<typeof getR1MeetDrainConfig>[0]) => {
    const config = getR1MeetDrainConfig(source);
    if (!config.available) throw new Error('expected an available drain config');
    return config;
  };

  it('is available with a well-formed key alone, whatever the flag and every other variable say', () => {
    for (const flag of [undefined, '', 'false', 'true', 'nope']) {
      const broken: R1MeetEnvSource = {
        R1_MEET_ENABLED: flag,
        R1_MEET_DAILY_BOT_CAP: '0',
        R1_MEET_ARM_AT_CREATE: 'x',
        R1_MEET_MULTI_HUMAN_POLICY: 'x',
        WEB_ORIGIN: 'http://x',
        RECALL_WEBHOOK_SECRET: 'nope',
        RECALL_API_KEY: RECALL_KEY_VALUE,
      };
      const config = available(broken);
      expect(config.recall.baseUrl, String(flag)).toBe(RECALL_DEFAULT_BASE_URL);
      expect(config.recall.apiKey, String(flag)).toBe(RECALL_KEY_VALUE);
    }
    expect(available({ RECALL_API_KEY: RECALL_KEY_VALUE, RECALL_BASE_URL: 'https://us-east-1.recall.ai/' }).recall.baseUrl).toBe(
      'https://us-east-1.recall.ai',
    );
    expect(available({ RECALL_API_KEY: RECALL_KEY_VALUE, RECALL_BASE_URL: '' }).recall.baseUrl).toBe(RECALL_DEFAULT_BASE_URL);
    expect(logged).toEqual([]);
  });

  it('is not available with no key, the placeholder, or a malformed key or base URL, and says nothing', () => {
    for (const key of [undefined, '', 'replace_me', 'short', `${RECALL_KEY_VALUE} `, `\t${RECALL_KEY_VALUE}`, 'k'.repeat(257), 42, null, {}]) {
      expect(getR1MeetDrainConfig({ RECALL_API_KEY: key as string }), String(key)).toStrictEqual({ available: false });
    }
    for (const base of ['http://ap-northeast-1.recall.ai', 'https://evil.example', 'https://recall.ai', 'x', 7]) {
      expect(
        getR1MeetDrainConfig({ RECALL_API_KEY: RECALL_KEY_VALUE, RECALL_BASE_URL: base as string }),
        String(base),
      ).toStrictEqual({ available: false });
    }
    expect(getR1MeetDrainConfig({})).toStrictEqual({ available: false });
    expect(logged).toEqual([]);
  });

  it('reads only the Recall key and base URL', () => {
    const reads: string[] = [];
    const source = new Proxy({ RECALL_API_KEY: RECALL_KEY_VALUE } as R1MeetEnvSource, {
      get(target, name) {
        reads.push(String(name));
        return target[name as keyof R1MeetEnvSource];
      },
    });
    expect(getR1MeetDrainConfig(source).available).toBe(true);
    expect([...new Set(reads)].sort()).toEqual(['RECALL_API_KEY', 'RECALL_BASE_URL']);
  });

  it('reads process.env when no source is passed, with the flag off', () => {
    vi.stubEnv('R1_MEET_ENABLED', 'false');
    vi.stubEnv('RECALL_API_KEY', RECALL_KEY_VALUE);
    vi.stubEnv('RECALL_BASE_URL', 'https://us-east-1.recall.ai');
    const config = getR1MeetDrainConfig();
    expect(config.available && [config.recall.baseUrl, config.recall.apiKey]).toEqual(['https://us-east-1.recall.ai', RECALL_KEY_VALUE]);
    vi.stubEnv('RECALL_API_KEY', '');
    expect(getR1MeetDrainConfig()).toStrictEqual({ available: false });
  });

  it('never throws, and keeps the key out of every enumeration', () => {
    const throwing = new Proxy({} as R1MeetEnvSource, {
      get() {
        throw new Error('boom');
      },
    });
    expect(getR1MeetDrainConfig(throwing)).toStrictEqual({ available: false });
    const config = available({ RECALL_API_KEY: RECALL_KEY_VALUE });
    const text = [
      JSON.stringify(config),
      JSON.stringify(config.recall),
      JSON.stringify({ ...config.recall }),
      JSON.stringify(Object.entries(config.recall)),
      Object.keys(config.recall).join(','),
    ].join('\n');
    expect(text).not.toContain(RECALL_KEY_VALUE);
    expect(Object.keys(config.recall)).toEqual(['baseUrl']);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.recall)).toBe(true);
    expect(logged).toEqual([]);
  });

  it('is allowed only for a deliberate "off": never while enabled, and never for an invalid configuration', () => {
    expect(r1MeetDrainAllowed(getR1MeetConfig({}))).toBe(true);
    for (const flag of [undefined, '', 'false']) {
      expect(r1MeetDrainAllowed(getR1MeetConfig(valid({ R1_MEET_ENABLED: flag }))), String(flag)).toBe(true);
    }
    expect(r1MeetDrainAllowed(getR1MeetConfig(valid()))).toBe(false);
    for (const bad of [
      valid({ R1_MEET_ENABLED: 'False' }),
      valid({ R1_MEET_DAILY_BOT_CAP: '0' }),
      valid({ R1_MEET_ARM_AT_CREATE: 'x' }),
      valid({ RECALL_API_KEY: '' }),
    ]) {
      const config = getR1MeetConfig(bad);
      expect(config.status).toBe('invalid');
      expect(r1MeetDrainAllowed(config)).toBe(false);
    }
  });
});

describe('R1 Meet configuration: the Ashby feedback form (M034 S09)', () => {
  const FEEDBACK_REASON = 'R1_MEET_ASHBY_FEEDBACK_FORM_ID must be a UUID (the feedback form of the Dex interview in Ashby)';
  const FEEDBACK_UNEXPECTED_REASON = 'unexpected error while reading the Meet feedback configuration';
  const feedback = (value: unknown): R1MeetFeedbackConfig =>
    getR1MeetFeedbackConfig({ R1_MEET_ASHBY_FEEDBACK_FORM_ID: value as string });

  it('is off (inert) when unset or blank', () => {
    for (const config of [getR1MeetFeedbackConfig({}), feedback(undefined), feedback('')]) {
      expect(config).toStrictEqual({ status: 'off' });
      expect(Object.isFrozen(config)).toBe(true);
    }
    expect(logged).toEqual([]);
  });

  it('is on for a UUID in either case, lower-cased (an id pasted in upper case names the same form, S09-R4)', () => {
    for (const formId of [FORM_ID, FORM_ID.toUpperCase(), GROUP_ID, GROUP_ID.toUpperCase()]) {
      const config = feedback(formId);
      expect(config, formId).toStrictEqual({ status: 'on', formDefinitionId: formId.toLowerCase() });
      expect(Object.isFrozen(config), formId).toBe(true);
    }
    expect(feedback(FORM_ID.toUpperCase())).toStrictEqual(feedback(FORM_ID));
    expect(logged).toEqual([]);
  });

  it('is invalid for anything else, the nil UUID included, with a reason that never carries the value', () => {
    const bad: unknown[] = [
      'not-a-uuid',
      ` ${FORM_ID}`,
      `${FORM_ID} `,
      `${FORM_ID}\n`,
      ' ',
      FORM_ID.replace(/-/g, ''),
      `{${FORM_ID}}`,
      FORM_ID.slice(0, -1),
      `${FORM_ID}0`,
      NIL_UUID,
      'replace_me',
      42,
      null,
      {},
      [FORM_ID],
      true,
    ];
    for (const value of bad) {
      const config = feedback(value);
      expect(config, JSON.stringify(value)).toStrictEqual({ status: 'invalid', reason: FEEDBACK_REASON });
      expect(Object.isFrozen(config)).toBe(true);
    }
    expect(FEEDBACK_REASON).not.toContain(FORM_ID);
    // Silent: the S09 handler alerts per affected interview; this reader never logs.
    expect(logged).toEqual([]);
  });

  it('never throws, even when the source itself throws, and stays silent', () => {
    const throwingGetter = {} as R1MeetEnvSource;
    Object.defineProperty(throwingGetter, 'R1_MEET_ASHBY_FEEDBACK_FORM_ID', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const throwingEverywhere = new Proxy({} as R1MeetEnvSource, {
      get() {
        throw new Error('boom');
      },
    });
    for (const source of [throwingGetter, throwingEverywhere]) {
      let result: R1MeetFeedbackConfig | undefined;
      expect(() => {
        result = getR1MeetFeedbackConfig(source);
      }).not.toThrow();
      expect(result).toStrictEqual({ status: 'invalid', reason: FEEDBACK_UNEXPECTED_REASON });
    }
    expect(logged).toEqual([]);
  });

  it('reads only R1_MEET_ASHBY_FEEDBACK_FORM_ID', () => {
    const reads: string[] = [];
    const source = new Proxy(valid({ R1_MEET_ASHBY_FEEDBACK_FORM_ID: FORM_ID }), {
      get(target, name) {
        reads.push(String(name));
        return target[name as keyof R1MeetEnvSource];
      },
    });
    expect(getR1MeetFeedbackConfig(source)).toStrictEqual({ status: 'on', formDefinitionId: FORM_ID });
    expect([...new Set(reads)]).toEqual(['R1_MEET_ASHBY_FEEDBACK_FORM_ID']);
  });

  it('reads process.env when no source is passed', () => {
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', FORM_ID);
    expect(getR1MeetFeedbackConfig()).toStrictEqual({ status: 'on', formDefinitionId: FORM_ID });
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', 'nope');
    expect(getR1MeetFeedbackConfig()).toStrictEqual({ status: 'invalid', reason: FEEDBACK_REASON });
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', '');
    expect(getR1MeetFeedbackConfig()).toStrictEqual({ status: 'off' });
    expect(logged).toEqual([]);
  });

  it('is independent of the Meet flag: the form id is read whatever R1_MEET_ENABLED says', () => {
    for (const flag of [undefined, '', 'false', 'true', 'nope']) {
      expect(
        getR1MeetFeedbackConfig(valid({ R1_MEET_ENABLED: flag, R1_MEET_ASHBY_FEEDBACK_FORM_ID: FORM_ID })),
        String(flag),
      ).toStrictEqual({ status: 'on', formDefinitionId: FORM_ID });
    }
  });

  it('getR1MeetConfig ignores it: the same answer with it unset, valid or malformed, and it is never read', () => {
    const bases: R1MeetEnvSource[] = [
      valid(),
      valid({ R1_MEET_SERVICE_USER_ID: SERVICE_ID, R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID }),
      {},
      valid({ R1_MEET_ENABLED: 'false' }),
      valid({ R1_MEET_ENABLED: 'yes' }),
      valid({ R1_MEET_DAILY_BOT_CAP: '0' }),
      valid({ RECALL_API_KEY: undefined }),
    ];
    for (const [index, base] of bases.entries()) {
      const without = getR1MeetConfig(base);
      for (const formId of [FORM_ID, 'not-a-uuid', NIL_UUID, '']) {
        const withIt = getR1MeetConfig({ ...base, R1_MEET_ASHBY_FEEDBACK_FORM_ID: formId });
        expect(withIt, `${index}: ${formId}`).toStrictEqual(without);
        if (without.enabled && withIt.enabled) {
          // The hidden credentials are non-enumerable, so toStrictEqual skips them: compare by name.
          expect([withIt.recall.apiKey, withIt.recall.webhookSecret]).toEqual([
            without.recall.apiKey,
            without.recall.webhookSecret,
          ]);
        }
      }
    }
    expect(getR1MeetConfig(valid({ R1_MEET_ASHBY_FEEDBACK_FORM_ID: 'not-a-uuid' })).status).toBe('enabled');

    const reads: string[] = [];
    const source = new Proxy(valid({ R1_MEET_ASHBY_FEEDBACK_FORM_ID: 'not-a-uuid' }), {
      get(target, name) {
        reads.push(String(name));
        return target[name as keyof R1MeetEnvSource];
      },
    });
    expect(getR1MeetConfig(source).status).toBe('enabled');
    expect(reads).not.toContain('R1_MEET_ASHBY_FEEDBACK_FORM_ID');
    // The invalid Meet bases above logged their own reasons; the form id never added a line.
    for (const line of logged) expect(line).not.toContain('FEEDBACK');
  });

  it('getR1MeetConfig from process.env is unchanged by a malformed form id', () => {
    for (const name of R1_MEET_ENV_VARIABLES) vi.stubEnv(name, '');
    vi.stubEnv('R1_MEET_ENABLED', 'true');
    vi.stubEnv('R1_MEET_ASHBY_DEX_USER_ID', DEX_ID);
    vi.stubEnv('RECALL_API_KEY', RECALL_KEY_VALUE);
    vi.stubEnv('RECALL_WEBHOOK_SECRET', RECALL_WEBHOOK_VALUE);
    vi.stubEnv('WEB_ORIGIN', WEB);
    const without = getR1MeetConfig();
    expect(without.status).toBe('enabled');
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', 'not-a-uuid');
    expect(getR1MeetConfig()).toStrictEqual(without);
    expect(getR1MeetFeedbackConfig().status).toBe('invalid');
    expect(logged).toEqual([]);
  });
});

describe('R1 Meet configuration: env contract', () => {
  const schema = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../../config/environment.schema.json', import.meta.url)), 'utf8'),
  ) as { components: { api: { variables: Record<string, { requiredInProduction: boolean; secret: boolean; external?: boolean }> } } };
  const example = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');

  it('lists exactly the thirty-five Meet variables: the twelve M034 ones, then the twenty-three M035 public ones', () => {
    const PUBLIC_NAMES = [
      'R1_MEET_PUBLIC_BOOKING_ENABLED',
      'R1_MEET_GOOGLE_AUTH_MODE',
      'R1_MEET_GOOGLE_OAUTH_CLIENT_ID',
      'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET',
      'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN',
      'R1_MEET_GOOGLE_SA_KEY_B64',
      'R1_MEET_GOOGLE_DEX_EMAIL',
      'R1_MEET_GOOGLE_MEET_MODE',
      'R1_MEET_PUBLIC_SLOT_MINUTES',
      'R1_MEET_PUBLIC_SLOT_STEP_MINUTES',
      'R1_MEET_PUBLIC_HOURS_IST',
      'R1_MEET_PUBLIC_DAYS',
      'R1_MEET_PUBLIC_CLOSED_DATES',
      'R1_MEET_PUBLIC_MIN_NOTICE_MINUTES',
      'R1_MEET_PUBLIC_HORIZON_DAYS',
      'R1_MEET_PUBLIC_SLOT_CAPACITY',
      'R1_MEET_PUBLIC_BROWSER_HEADROOM',
      'R1_MEET_PUBLIC_DAILY_CAP',
      'R1_MEET_PUBLIC_MAX_MOVES',
      'R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES',
      'R1_MEET_PUBLIC_REQUIRE_R1_STAGE',
      'R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS',
      'R1_MEET_PUBLIC_PRESLOT_RECHECK',
    ];
    expect([...R1_MEET_PUBLIC_ENV_VARIABLES]).toEqual(PUBLIC_NAMES);
    expect([...R1_MEET_ENV_VARIABLES]).toEqual([
      'R1_MEET_ENABLED',
      'R1_MEET_BOT_NAME',
      'R1_MEET_DAILY_BOT_CAP',
      'R1_MEET_GOOGLE_LOGIN_GROUP_ID',
      'R1_MEET_SERVICE_USER_ID',
      'RECALL_BASE_URL',
      'R1_MEET_ARM_AT_CREATE',
      'R1_MEET_MULTI_HUMAN_POLICY',
      'R1_MEET_ASHBY_DEX_USER_ID',
      'R1_MEET_ASHBY_FEEDBACK_FORM_ID',
      'RECALL_API_KEY',
      'RECALL_WEBHOOK_SECRET',
      ...PUBLIC_NAMES,
    ]);
    expect(R1_MEET_ENV_VARIABLES).toHaveLength(35);
    expect(new Set(R1_MEET_ENV_VARIABLES).size).toBe(35);
  });

  it('declares each in the api schema: optional, secret exactly for the Recall pair and the three Google credentials, never external', () => {
    const secrets = new Set<string>([...R1_MEET_SECRET_VARIABLES, ...R1_MEET_PUBLIC_SECRET_VARIABLES]);
    expect([...secrets]).toEqual([
      'RECALL_API_KEY',
      'RECALL_WEBHOOK_SECRET',
      'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET',
      'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN',
      'R1_MEET_GOOGLE_SA_KEY_B64',
    ]);
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
    const secrets = new Set<string>([...R1_MEET_SECRET_VARIABLES, ...R1_MEET_PUBLIC_SECRET_VARIABLES]);
    const parsed: Record<string, string> = {};
    for (const name of R1_MEET_ENV_VARIABLES) {
      const match = new RegExp(`^${name}=(.*)$`, 'm').exec(example);
      expect(match, name).not.toBeNull();
      expect(match![1], name).toBe(secrets.has(name) ? 'replace_me' : '');
      parsed[name] = match![1]!;
    }
    expect(example).not.toMatch(/whsec_[A-Za-z0-9+/]{8,}/);
    // No Google-shaped example value and no PEM armour (both built so this file never spells them).
    const googleShaped = new RegExp(['GOC' + 'SPX-', 'ya' + '29\\.', 'AI' + 'za[0-9A-Za-z_-]{20,}'].join('|'));
    expect(example).not.toMatch(googleShaped);
    expect(example).not.toContain(['PRIVATE', 'KEY'].join(' '));
    // A copied example file is "disabled", not "half configured".
    expect(getR1MeetConfig(parsed as R1MeetEnvSource)).toEqual({ enabled: false, status: 'disabled' });
    expect(getR1MeetFeedbackConfig(parsed as R1MeetEnvSource)).toStrictEqual({ status: 'off' });
    // M035: the public link is off, and the placeholders give the Google drain nothing to use.
    expect(getR1MeetPublicConfig(parsed as R1MeetEnvSource)).toStrictEqual({ status: 'off' });
    expect(getR1MeetPublicDrainConfig(parsed as R1MeetEnvSource)).toStrictEqual({ available: false });
    // Even with the public flag flipped on, the copied file stays inert: Meet itself is disabled.
    const flipped = getR1MeetPublicConfig({ ...(parsed as R1MeetEnvSource), R1_MEET_PUBLIC_BOOKING_ENABLED: 'true' });
    expect(flipped.status).toBe('invalid');
    expect(logged).toEqual([]);
  });
});

describe('R1 Meet configuration: the M035 public variables never reach getR1MeetConfig', () => {
  /** One malformed value per public variable (each would make the public config invalid). */
  const MALFORMED_PUBLIC: Record<string, string> = {
    R1_MEET_PUBLIC_BOOKING_ENABLED: 'yes',
    R1_MEET_GOOGLE_AUTH_MODE: 'dwd',
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'not a client id',
    R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: ' ',
    R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: ' ',
    R1_MEET_GOOGLE_SA_KEY_B64: '%%%',
    R1_MEET_GOOGLE_DEX_EMAIL: 'not-an-email',
    R1_MEET_GOOGLE_MEET_MODE: 'zoom',
    R1_MEET_PUBLIC_SLOT_MINUTES: '0',
    R1_MEET_PUBLIC_SLOT_STEP_MINUTES: '7',
    R1_MEET_PUBLIC_HOURS_IST: '25:00-26:00',
    R1_MEET_PUBLIC_DAYS: 'funday',
    R1_MEET_PUBLIC_CLOSED_DATES: '2026-02-30',
    R1_MEET_PUBLIC_MIN_NOTICE_MINUTES: '1',
    R1_MEET_PUBLIC_HORIZON_DAYS: '99',
    R1_MEET_PUBLIC_SLOT_CAPACITY: '0',
    R1_MEET_PUBLIC_BROWSER_HEADROOM: '-1',
    R1_MEET_PUBLIC_DAILY_CAP: '0',
    R1_MEET_PUBLIC_MAX_MOVES: '11',
    R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES: '1',
    R1_MEET_PUBLIC_REQUIRE_R1_STAGE: 'maybe',
    R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS: '0',
    R1_MEET_PUBLIC_PRESLOT_RECHECK: 'maybe',
  };

  it('covers every public variable', () => {
    expect(Object.keys(MALFORMED_PUBLIC)).toEqual([...R1_MEET_PUBLIC_ENV_VARIABLES]);
  });

  it('getR1MeetConfig never reads one of the twenty-three public names', () => {
    const reads: string[] = [];
    const source = new Proxy(valid({ R1_MEET_SERVICE_USER_ID: SERVICE_ID, ...MALFORMED_PUBLIC }), {
      get(target, name) {
        reads.push(String(name));
        return target[name as keyof R1MeetEnvSource];
      },
    });
    expect(getR1MeetConfig(source).status).toBe('enabled');
    expect(reads.length).toBeGreaterThan(0);
    for (const name of R1_MEET_PUBLIC_ENV_VARIABLES) expect(reads, name).not.toContain(name);
  });

  it('answers exactly the same with every public variable malformed, for every Meet state', () => {
    const bases: R1MeetEnvSource[] = [
      valid(),
      valid({ R1_MEET_SERVICE_USER_ID: SERVICE_ID, R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID }),
      {},
      valid({ R1_MEET_ENABLED: 'false' }),
      valid({ R1_MEET_ENABLED: 'yes' }),
      valid({ R1_MEET_DAILY_BOT_CAP: '0' }),
      valid({ RECALL_API_KEY: undefined }),
    ];
    for (const [index, base] of bases.entries()) {
      const without = getR1MeetConfig(base);
      const withPublic = getR1MeetConfig({ ...base, ...MALFORMED_PUBLIC });
      expect(withPublic, String(index)).toStrictEqual(without);
      if (without.enabled && withPublic.enabled) {
        // The hidden credentials are non-enumerable, so toStrictEqual skips them: compare by name.
        expect([withPublic.recall.apiKey, withPublic.recall.webhookSecret]).toEqual([
          without.recall.apiKey,
          without.recall.webhookSecret,
        ]);
      }
    }
    // The public reader turns the bad values into its own (silent) reason; Meet stays enabled.
    expect(getR1MeetPublicConfig({ ...valid(), ...MALFORMED_PUBLIC }).status).toBe('invalid');
    expect(getR1MeetConfig({ ...valid(), ...MALFORMED_PUBLIC }).status).toBe('enabled');
    for (const line of logged) expect(line).not.toMatch(/PUBLIC|GOOGLE_(?:AUTH|OAUTH|SA|DEX|MEET_MODE)/);
  });

  it('getR1MeetConfig from process.env is unchanged with every public variable malformed', () => {
    for (const name of R1_MEET_ENV_VARIABLES) vi.stubEnv(name, '');
    vi.stubEnv('R1_MEET_ENABLED', 'true');
    vi.stubEnv('R1_MEET_ASHBY_DEX_USER_ID', DEX_ID);
    vi.stubEnv('RECALL_API_KEY', RECALL_KEY_VALUE);
    vi.stubEnv('RECALL_WEBHOOK_SECRET', RECALL_WEBHOOK_VALUE);
    vi.stubEnv('WEB_ORIGIN', WEB);
    const without = getR1MeetConfig();
    expect(without.status).toBe('enabled');
    for (const [name, bad] of Object.entries(MALFORMED_PUBLIC)) vi.stubEnv(name, bad);
    expect(getR1MeetConfig()).toStrictEqual(without);
    expect(getR1MeetPublicConfig().status).toBe('invalid');
    expect(logged).toEqual([]);
  });
});
