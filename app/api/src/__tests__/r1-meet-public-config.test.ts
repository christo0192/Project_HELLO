/**
 * M035 S03 T2: the public booking link's configuration (dark by default).
 *
 * `getR1MeetPublicConfig` is a SEPARATE, silent reader on top of the Meet configuration: strict flag,
 * the knobs of contract §2 validated in table order, then Meet `enabled` with a service user, then
 * Dex's email and the chosen auth mode's credentials present, then well formed. The DEFAULT auth mode
 * is `oauth_refresh` (Dex is a user of the company Workspace), the DEFAULT bot is the guest bot (no
 * login group required), the secrets are non-enumerable, reasons never carry a value, it never
 * throws, and it never changes what `getR1MeetConfig` answers. Plus the Google half of the drain and
 * the consent helper's inputs.
 *
 * Fixtures are built at run time and low in entropy: no Google-shaped value, no PEM text and no
 * `whsec_`-prefixed base64 literal appears in this file (gitleaks scans the PR history). The RSA pair
 * is generated per run.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  R1_MEET_ENV_VARIABLES,
  R1_MEET_GOOGLE_AUTH_MODES,
  R1_MEET_GOOGLE_AUTH_MODE_DEFAULT,
  R1_MEET_GOOGLE_MEET_MODES,
  R1_MEET_GOOGLE_MEET_MODE_DEFAULT,
  R1_MEET_GOOGLE_SA_KEY_MAX_BYTES,
  R1_MEET_PUBLIC_BOOK_PAGE_PATH,
  R1_MEET_PUBLIC_CLOSED_DATES_MAX,
  R1_MEET_PUBLIC_DAYS_DEFAULT,
  R1_MEET_PUBLIC_EARLIEST_START_MINUTE_IST,
  R1_MEET_PUBLIC_ENV_VARIABLES,
  R1_MEET_PUBLIC_HOURS_IST_DEFAULT,
  R1_MEET_PUBLIC_INTEGER_KNOBS,
  R1_MEET_PUBLIC_MANAGE_PAGE_PATH,
  R1_MEET_PUBLIC_PRESLOT_RECHECK_DEFAULT,
  R1_MEET_PUBLIC_REQUIRE_R1_STAGE_DEFAULT,
  R1_MEET_PUBLIC_SECRET_VARIABLES,
  R1_MEET_PUBLIC_SLOT_STEP_MINUTES_CHOICES,
  R1_MEET_PUBLIC_SLOT_STEP_MINUTES_DEFAULT,
  getR1MeetConfig,
  getR1MeetGoogleOAuthClientInputs,
  getR1MeetPublicConfig,
  getR1MeetPublicDrainConfig,
  r1MeetPublicActive,
  resetR1MeetConfigReport,
  type R1MeetConfig,
  type R1MeetEnvSource,
  type R1MeetGoogleOAuthClientInputs,
  type R1MeetGoogleSettings,
  type R1MeetPublicConfig,
  type R1MeetPublicDrainConfig,
} from '../lib/r1/meet/config.js';
import {
  GOOGLE_SCOPES,
  createGoogleDwdTokenSource,
  createGoogleOAuthRefreshTokenSource,
} from '../integrations/google/token.js';

// ── Fixtures (built at run time, low entropy) ──────────────────────────────────────────────────────

const RECALL_KEY_VALUE = 'recall-canary-' + 'k'.repeat(20);
const RECALL_WEBHOOK_VALUE = 'whsec' + '_' + randomBytes(32).toString('base64');
const WEB = 'https://hello.example.test';
const DEX_ID = '5e1d0c9b-8a7f-4e6d-9c5b-4a3f2e1d0c9b';
const SERVICE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const GROUP_ID = '7d3c2b1a-0f9e-4d8c-9b7a-6f5e4d3c2b1a';

const GOOGLE_SUFFIX = '.apps.googleusercontent.com';
const CLIENT_ID_VALUE = ['hello', 'r1', 'public'].join('-') + GOOGLE_SUFFIX;
const CS_VALUE = 'canary-cs-' + 's'.repeat(30);
const RT_VALUE = 'canary-rt-' + 'r'.repeat(40);
const DEX_EMAIL = 'dex@hello.example.test';
const SA_EMAIL = 'hello-r1-dwd@hello-project.example.test';
const KID = 'kid' + '0'.repeat(37);

// A throwaway RSA pair, generated per run: no PEM text exists in the repository.
const PAIR = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PKCS1_PEM = PAIR.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const ARMOUR_WORD = ['PRIVATE', 'KEY'].join(' ');

function saJson(overrides: Record<string, unknown> = {}, drop: readonly string[] = []): Record<string, unknown> {
  const json: Record<string, unknown> = {
    type: 'service_account',
    project_id: 'hello-project',
    private_key_id: KID,
    private_key: PEM,
    client_email: SA_EMAIL,
    client_id: '1'.repeat(21),
    ...overrides,
  };
  for (const name of drop) delete json[name];
  return json;
}
const b64 = (value: string | Buffer): string => Buffer.from(value).toString('base64');
const saKey = (overrides: Record<string, unknown> = {}, drop: readonly string[] = []): string =>
  b64(JSON.stringify(saJson(overrides, drop)));

/** A Meet configuration that is `enabled`, with the service user the public link needs. */
const meetValid = (extra: R1MeetEnvSource = {}): R1MeetEnvSource => ({
  R1_MEET_ENABLED: 'true',
  RECALL_API_KEY: RECALL_KEY_VALUE,
  RECALL_WEBHOOK_SECRET: RECALL_WEBHOOK_VALUE,
  R1_MEET_ASHBY_DEX_USER_ID: DEX_ID,
  R1_MEET_SERVICE_USER_ID: SERVICE_ID,
  WEB_ORIGIN: WEB,
  ...extra,
});

/** The minimum valid public configuration: the flag, Dex's email and the three OAuth values. */
const pubValid = (extra: R1MeetEnvSource = {}): R1MeetEnvSource =>
  meetValid({
    R1_MEET_PUBLIC_BOOKING_ENABLED: 'true',
    R1_MEET_GOOGLE_DEX_EMAIL: DEX_EMAIL,
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID_VALUE,
    R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: CS_VALUE,
    R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: RT_VALUE,
    ...extra,
  });

/** The same in service-account mode (the OAuth values removed). */
const saValid = (extra: R1MeetEnvSource = {}): R1MeetEnvSource =>
  pubValid({
    R1_MEET_GOOGLE_AUTH_MODE: 'service_account',
    R1_MEET_GOOGLE_SA_KEY_B64: saKey(),
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: undefined,
    R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: undefined,
    ...extra,
  });

// ── The fixed reasons (pinned) ─────────────────────────────────────────────────────────────────────

const FLAG_REASON = 'R1_MEET_PUBLIC_BOOKING_ENABLED must be either "true" or "false"';
const AUTH_MODE_REASON = 'R1_MEET_GOOGLE_AUTH_MODE must be "oauth_refresh" or "service_account"';
const MEET_MODE_REASON = 'R1_MEET_GOOGLE_MEET_MODE must be "calendar" or "space"';
const STEP_REASON = 'R1_MEET_PUBLIC_SLOT_STEP_MINUTES must be 15, 30 or 60';
const HOURS_REASON =
  'R1_MEET_PUBLIC_HOURS_IST must be HH:MM-HH:MM: first start at 09:00 or later, last start not before it, both on the R1_MEET_PUBLIC_SLOT_STEP_MINUTES grid, and the last slot ending by 24:00';
const DAYS_REASON = 'R1_MEET_PUBLIC_DAYS must be a comma list of mon..sun days or ascending ranges such as mon-fri';
const CLOSED_REASON = 'R1_MEET_PUBLIC_CLOSED_DATES must be a comma list of at most 100 real YYYY-MM-DD dates';
const intReason = (name: string, min: number, max: number): string => `${name} must be an integer from ${min} to ${max}`;
const boolReason = (name: string): string => `${name} must be either "true" or "false"`;
const MEET_REASON =
  'R1_MEET_PUBLIC_BOOKING_ENABLED is "true" but the Meet configuration is not enabled (R1_MEET_ENABLED)';
const SERVICE_REASON = 'R1_MEET_SERVICE_USER_ID is required when R1_MEET_PUBLIC_BOOKING_ENABLED is "true"';
const DEX_REQUIRED = 'R1_MEET_GOOGLE_DEX_EMAIL is required when R1_MEET_PUBLIC_BOOKING_ENABLED is "true"';
const credRequired = (name: string, mode: string): string => `${name} is required when R1_MEET_GOOGLE_AUTH_MODE is "${mode}"`;
const DEX_MALFORMED = 'R1_MEET_GOOGLE_DEX_EMAIL must be one email address of at most 254 characters';
const CLIENT_ID_MALFORMED =
  'R1_MEET_GOOGLE_OAUTH_CLIENT_ID must end with .apps.googleusercontent.com (at most 200 characters, no spaces)';
const opaqueMalformed = (name: string): string => `${name} is malformed`;
const CS_MALFORMED = opaqueMalformed('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET');
const RT_MALFORMED = opaqueMalformed('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN');
const SA_MALFORMED = opaqueMalformed('R1_MEET_GOOGLE_SA_KEY_B64') + ' (expected base64 of a service-account JSON key)';
const UNEXPECTED_REASON = 'unexpected error while reading the public booking configuration';

// ── Harness ────────────────────────────────────────────────────────────────────────────────────────

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

type PublicOn = Extract<R1MeetPublicConfig, { status: 'on' }>;
type OAuthSettings = Extract<R1MeetGoogleSettings, { authMode: 'oauth_refresh' }>;
type ServiceAccountSettings = Extract<R1MeetGoogleSettings, { authMode: 'service_account' }>;

function on(config: R1MeetPublicConfig): PublicOn {
  if (config.status !== 'on') {
    throw new Error(`expected on, got ${config.status}${config.status === 'invalid' ? `: ${config.reason}` : ''}`);
  }
  return config;
}
function oauth(google: R1MeetGoogleSettings): OAuthSettings {
  if (google.authMode !== 'oauth_refresh') throw new Error('expected oauth_refresh settings');
  return google;
}
function serviceAccount(google: R1MeetGoogleSettings): ServiceAccountSettings {
  if (google.authMode !== 'service_account') throw new Error('expected service_account settings');
  return google;
}
function expectInvalid(config: R1MeetPublicConfig, reason: string, label?: string): void {
  expect(config, label).toStrictEqual({ status: 'invalid', reason });
  expect(Object.isFrozen(config), label).toBe(true);
}
const publicWith = (extra: Record<string, unknown>): R1MeetPublicConfig =>
  getR1MeetPublicConfig(pubValid(extra as R1MeetEnvSource));

/** Every public variable malformed (each one alone would make the public config invalid). */
const MALFORMED_PUBLIC: Record<string, string> = {
  R1_MEET_GOOGLE_AUTH_MODE: 'dwd',
  R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'nope',
  R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: ' ',
  R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: ' ',
  R1_MEET_GOOGLE_SA_KEY_B64: '%%%',
  R1_MEET_GOOGLE_DEX_EMAIL: 'nope',
  R1_MEET_GOOGLE_MEET_MODE: 'zoom',
  R1_MEET_PUBLIC_SLOT_MINUTES: '0',
  R1_MEET_PUBLIC_SLOT_STEP_MINUTES: '7',
  R1_MEET_PUBLIC_HOURS_IST: 'nope',
  R1_MEET_PUBLIC_DAYS: 'funday',
  R1_MEET_PUBLIC_CLOSED_DATES: '2026-02-30',
  R1_MEET_PUBLIC_MIN_NOTICE_MINUTES: '0',
  R1_MEET_PUBLIC_HORIZON_DAYS: '0',
  R1_MEET_PUBLIC_SLOT_CAPACITY: '0',
  R1_MEET_PUBLIC_BROWSER_HEADROOM: '99',
  R1_MEET_PUBLIC_DAILY_CAP: '0',
  R1_MEET_PUBLIC_MAX_MOVES: '99',
  R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES: '0',
  R1_MEET_PUBLIC_REQUIRE_R1_STAGE: 'maybe',
  R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS: '0',
  R1_MEET_PUBLIC_PRESLOT_RECHECK: 'maybe',
};

// ── off ────────────────────────────────────────────────────────────────────────────────────────────

describe('M035 public booking configuration: off', () => {
  it('is off for an empty environment', () => {
    const config = getR1MeetPublicConfig({});
    expect(config).toStrictEqual({ status: 'off' });
    expect(Object.isFrozen(config)).toBe(true);
    expect(logged).toEqual([]);
  });

  it('is off (and silent) when the flag is unset, blank or "false", even with every other value malformed and Meet invalid', () => {
    for (const flag of [undefined, '', 'false']) {
      const broken = {
        ...MALFORMED_PUBLIC,
        R1_MEET_PUBLIC_BOOKING_ENABLED: flag,
        R1_MEET_ENABLED: 'yes',
        R1_MEET_DAILY_BOT_CAP: '0',
        RECALL_API_KEY: 'short',
        WEB_ORIGIN: 'http://x',
      } as R1MeetEnvSource;
      expect(getR1MeetPublicConfig(broken), String(flag)).toStrictEqual({ status: 'off' });
      expect(getR1MeetPublicConfig(pubValid({ R1_MEET_PUBLIC_BOOKING_ENABLED: flag })), String(flag)).toStrictEqual({
        status: 'off',
      });
    }
    // Not even the Meet dependency is read, so its own invalid line is never logged either.
    expect(logged).toEqual([]);
  });

  it('reads nothing but the flag while off', () => {
    const reads: string[] = [];
    const source = new Proxy(pubValid({ R1_MEET_PUBLIC_BOOKING_ENABLED: 'false' }), {
      get(target, name) {
        reads.push(String(name));
        return target[name as keyof R1MeetEnvSource];
      },
    });
    expect(getR1MeetPublicConfig(source)).toStrictEqual({ status: 'off' });
    expect([...new Set(reads)]).toEqual(['R1_MEET_PUBLIC_BOOKING_ENABLED']);
  });

  it('is invalid for any other flag value, silently', () => {
    const values: unknown[] = ['TRUE', 'True', ' true', 'true ', 'yes', '1', 'on', 'False', 'FALSE', '0', 'off', 'enabled'];
    for (const flag of [...values, true, 1, {}, null]) {
      expectInvalid(publicWith({ R1_MEET_PUBLIC_BOOKING_ENABLED: flag }), FLAG_REASON, String(flag));
    }
    expect(logged).toEqual([]);
  });
});

// ── on ─────────────────────────────────────────────────────────────────────────────────────────────

describe('M035 public booking configuration: on', () => {
  it('returns the exact documented shape with every default (contract §2)', () => {
    const config = on(getR1MeetPublicConfig(pubValid()));
    expect(Object.keys(config)).toEqual([
      'status',
      'google',
      'meetMode',
      'botMode',
      'slot',
      'maxMoves',
      'manageCutoffMinutes',
      'requireR1Stage',
      'calendarRetentionDays',
      'preSlotRecheck',
      'serviceUserId',
      'dailyBotCap',
      'bookPageUrl',
      'managePageUrl',
    ]);
    expect(config).toStrictEqual({
      status: 'on',
      google: { authMode: 'oauth_refresh', dexEmail: DEX_EMAIL, clientId: CLIENT_ID_VALUE },
      meetMode: 'calendar',
      botMode: 'guest',
      slot: {
        slotMinutes: 45,
        stepMinutes: 30,
        firstStartMinuteIst: 540,
        lastStartMinuteIst: 1230,
        isoWeekdays: [1, 2, 3, 4, 5, 6, 7],
        closedDates: [],
        minNoticeMinutes: 60,
        horizonDays: 7,
        slotCapacity: 2,
        browserHeadroom: 0,
        publicDailyCap: 20,
      },
      maxMoves: 3,
      manageCutoffMinutes: 30,
      requireR1Stage: false,
      calendarRetentionDays: 30,
      preSlotRecheck: true,
      serviceUserId: SERVICE_ID,
      dailyBotCap: 20,
      bookPageUrl: 'https://hello.example.test/book',
      managePageUrl: 'https://hello.example.test/book/manage',
    });
    expect(Object.keys(config.slot)).toEqual([
      'slotMinutes',
      'stepMinutes',
      'firstStartMinuteIst',
      'lastStartMinuteIst',
      'isoWeekdays',
      'closedDates',
      'minNoticeMinutes',
      'horizonDays',
      'slotCapacity',
      'browserHeadroom',
      'publicDailyCap',
    ]);
    // The two secrets are readable by name.
    const google = oauth(config.google);
    expect([google.clientSecret, google.refreshToken]).toEqual([CS_VALUE, RT_VALUE]);
    expect(logged).toEqual([]);
  });

  it('defaults to the GUEST bot: no R1_MEET_GOOGLE_LOGIN_GROUP_ID is needed (owner decision 2026-11-26)', () => {
    for (const group of [undefined, '']) {
      const config = on(getR1MeetPublicConfig(pubValid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: group })));
      expect(config.botMode, String(group)).toBe('guest');
    }
    expect(logged).toEqual([]);
  });

  it('is the signed-in bot only when the Meet configuration has a login group', () => {
    expect(on(getR1MeetPublicConfig(pubValid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID }))).botMode).toBe('signed_in');
    // A malformed group makes Meet invalid, which the public reader reports as the Meet reason.
    expectInvalid(getR1MeetPublicConfig(pubValid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: 'nope' })), MEET_REASON);
  });

  it('takes the service user and the daily bot cap from the Meet configuration', () => {
    const config = on(
      getR1MeetPublicConfig(pubValid({ R1_MEET_SERVICE_USER_ID: SERVICE_ID.toUpperCase(), R1_MEET_DAILY_BOT_CAP: '7' })),
    );
    expect(config.serviceUserId).toBe(SERVICE_ID);
    expect(config.dailyBotCap).toBe(7);
  });

  it.each([
    ['a comma list (first entry wins)', 'https://hello.example.test,https://other.example.test'],
    ['a comma list with spaces', ' https://hello.example.test , http://localhost:5173'],
    ['a trailing slash', 'https://hello.example.test/'],
    ['an upper-case host', 'https://Hello.Example.Test'],
  ])('builds the two page URLs on the first WEB_ORIGIN entry: %s', (_name, origin) => {
    const config = on(getR1MeetPublicConfig(pubValid({ WEB_ORIGIN: origin })));
    expect(config.bookPageUrl).toBe(`${WEB}${R1_MEET_PUBLIC_BOOK_PAGE_PATH}`);
    expect(config.managePageUrl).toBe(`${WEB}${R1_MEET_PUBLIC_MANAGE_PAGE_PATH}`);
  });

  it('pins the constants later slices build on', () => {
    expect([R1_MEET_PUBLIC_BOOK_PAGE_PATH, R1_MEET_PUBLIC_MANAGE_PAGE_PATH]).toEqual(['/book', '/book/manage']);
    expect([...R1_MEET_GOOGLE_AUTH_MODES]).toEqual(['oauth_refresh', 'service_account']);
    expect(R1_MEET_GOOGLE_AUTH_MODE_DEFAULT).toBe('oauth_refresh');
    expect([...R1_MEET_GOOGLE_MEET_MODES]).toEqual(['calendar', 'space']);
    expect(R1_MEET_GOOGLE_MEET_MODE_DEFAULT).toBe('calendar');
    expect([...R1_MEET_PUBLIC_SLOT_STEP_MINUTES_CHOICES]).toEqual([15, 30, 60]);
    expect(R1_MEET_PUBLIC_SLOT_STEP_MINUTES_DEFAULT).toBe(30);
    expect(R1_MEET_PUBLIC_HOURS_IST_DEFAULT).toBe('09:00-20:30');
    expect(R1_MEET_PUBLIC_EARLIEST_START_MINUTE_IST).toBe(540);
    expect(R1_MEET_PUBLIC_DAYS_DEFAULT).toBe('mon-sun');
    expect(R1_MEET_PUBLIC_CLOSED_DATES_MAX).toBe(100);
    expect(R1_MEET_PUBLIC_REQUIRE_R1_STAGE_DEFAULT).toBe(false);
    expect(R1_MEET_PUBLIC_PRESLOT_RECHECK_DEFAULT).toBe(true);
    expect(R1_MEET_GOOGLE_SA_KEY_MAX_BYTES).toBe(8192);
    expect(R1_MEET_PUBLIC_INTEGER_KNOBS).toStrictEqual({
      R1_MEET_PUBLIC_SLOT_MINUTES: { default: 45, min: 30, max: 60 },
      R1_MEET_PUBLIC_MIN_NOTICE_MINUTES: { default: 60, min: 30, max: 1440 },
      R1_MEET_PUBLIC_HORIZON_DAYS: { default: 7, min: 1, max: 13 },
      R1_MEET_PUBLIC_SLOT_CAPACITY: { default: 2, min: 1, max: 15 },
      R1_MEET_PUBLIC_BROWSER_HEADROOM: { default: 0, min: 0, max: 14 },
      R1_MEET_PUBLIC_DAILY_CAP: { default: 20, min: 1, max: 200 },
      R1_MEET_PUBLIC_MAX_MOVES: { default: 3, min: 0, max: 10 },
      R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES: { default: 30, min: 15, max: 720 },
      R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS: { default: 30, min: 1, max: 365 },
    });
    for (const frozen of [
      R1_MEET_GOOGLE_AUTH_MODES,
      R1_MEET_GOOGLE_MEET_MODES,
      R1_MEET_PUBLIC_SLOT_STEP_MINUTES_CHOICES,
      R1_MEET_PUBLIC_INTEGER_KNOBS,
      ...Object.values(R1_MEET_PUBLIC_INTEGER_KNOBS),
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect([...R1_MEET_PUBLIC_SECRET_VARIABLES]).toEqual([
      'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET',
      'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN',
      'R1_MEET_GOOGLE_SA_KEY_B64',
    ]);
    expect(R1_MEET_PUBLIC_ENV_VARIABLES).toHaveLength(23);
    expect([...R1_MEET_ENV_VARIABLES.slice(-23)]).toEqual([...R1_MEET_PUBLIC_ENV_VARIABLES]);
  });
});

// ── the knobs ──────────────────────────────────────────────────────────────────────────────────────

type IntegerRow = readonly [name: string, min: number, max: number, fallback: number, read: (c: PublicOn) => number];
const INTEGER_KNOBS: readonly IntegerRow[] = [
  ['R1_MEET_PUBLIC_SLOT_MINUTES', 30, 60, 45, (c) => c.slot.slotMinutes],
  ['R1_MEET_PUBLIC_MIN_NOTICE_MINUTES', 30, 1440, 60, (c) => c.slot.minNoticeMinutes],
  ['R1_MEET_PUBLIC_HORIZON_DAYS', 1, 13, 7, (c) => c.slot.horizonDays],
  ['R1_MEET_PUBLIC_SLOT_CAPACITY', 1, 15, 2, (c) => c.slot.slotCapacity],
  ['R1_MEET_PUBLIC_BROWSER_HEADROOM', 0, 14, 0, (c) => c.slot.browserHeadroom],
  ['R1_MEET_PUBLIC_DAILY_CAP', 1, 200, 20, (c) => c.slot.publicDailyCap],
  ['R1_MEET_PUBLIC_MAX_MOVES', 0, 10, 3, (c) => c.maxMoves],
  ['R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES', 15, 720, 30, (c) => c.manageCutoffMinutes],
  ['R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS', 1, 365, 30, (c) => c.calendarRetentionDays],
];

describe('M035 public booking configuration: the integer knobs', () => {
  it('the table matches the exported knob bounds', () => {
    expect(INTEGER_KNOBS.map(([name, min, max, fallback]) => [name, { default: fallback, min, max }])).toEqual(
      Object.entries(R1_MEET_PUBLIC_INTEGER_KNOBS),
    );
  });

  it.each(INTEGER_KNOBS)('%s: blank = default, edges accepted, never clamped', (name, min, max, fallback, read) => {
    for (const blank of [undefined, '']) expect(read(on(publicWith({ [name]: blank }))), `${name} blank`).toBe(fallback);
    for (const value of [min, max, Math.floor((min + max) / 2)]) {
      expect(read(on(publicWith({ [name]: String(value) }))), `${name}=${value}`).toBe(value);
    }
    // Leading zeros read as the number (the R1_MEET_DAILY_BOT_CAP rule).
    expect(read(on(publicWith({ [name]: `0${max}` })))).toBe(max);
    const reason = intReason(name, min, max);
    const bad: unknown[] = [
      String(max + 1),
      '9'.repeat(12),
      '1'.repeat(13),
      ' 5',
      '5 ',
      '+5',
      '-1',
      '1.0',
      '1e1',
      '0x1',
      'abc',
      ' ',
      5,
      null,
      {},
    ];
    if (min > 0) bad.push(String(min - 1));
    for (const value of bad) expectInvalid(publicWith({ [name]: value }), reason, `${name}=${String(value)}`);
    expect(logged).toEqual([]);
  });
});

describe('M035 public booking configuration: modes, step and booleans', () => {
  it('R1_MEET_GOOGLE_AUTH_MODE: blank = oauth_refresh; anything else than the two words is invalid', () => {
    for (const blank of [undefined, '']) {
      expect(on(publicWith({ R1_MEET_GOOGLE_AUTH_MODE: blank })).google.authMode).toBe('oauth_refresh');
    }
    expect(on(publicWith({ R1_MEET_GOOGLE_AUTH_MODE: 'oauth_refresh' })).google.authMode).toBe('oauth_refresh');
    for (const bad of ['OAUTH_REFRESH', 'oauth', 'refresh', 'dwd', ' oauth_refresh', 'service-account', 'serviceaccount', 7]) {
      expectInvalid(publicWith({ R1_MEET_GOOGLE_AUTH_MODE: bad }), AUTH_MODE_REASON, String(bad));
    }
  });

  it('R1_MEET_GOOGLE_MEET_MODE: blank = calendar; "space" is the fallback; anything else is invalid', () => {
    for (const blank of [undefined, '']) expect(on(publicWith({ R1_MEET_GOOGLE_MEET_MODE: blank })).meetMode).toBe('calendar');
    expect(on(publicWith({ R1_MEET_GOOGLE_MEET_MODE: 'calendar' })).meetMode).toBe('calendar');
    expect(on(publicWith({ R1_MEET_GOOGLE_MEET_MODE: 'space' })).meetMode).toBe('space');
    for (const bad of ['Calendar', 'SPACE', 'meet', ' space', 'space ', 'zoom', 1]) {
      expectInvalid(publicWith({ R1_MEET_GOOGLE_MEET_MODE: bad }), MEET_MODE_REASON, String(bad));
    }
  });

  it.each([
    ['15', '09:00-20:30', 15],
    ['30', '09:00-20:30', 30],
    ['60', '09:00-20:00', 60],
    ['030', '09:00-20:30', 30],
    ['', '09:00-20:30', 30],
  ])('R1_MEET_PUBLIC_SLOT_STEP_MINUTES=%j with hours %s is %d', (step, hours, expected) => {
    const config = on(publicWith({ R1_MEET_PUBLIC_SLOT_STEP_MINUTES: step, R1_MEET_PUBLIC_HOURS_IST: hours }));
    expect(config.slot.stepMinutes).toBe(expected);
  });

  it('R1_MEET_PUBLIC_SLOT_STEP_MINUTES: anything but 15, 30 or 60 is invalid', () => {
    for (const bad of ['0', '5', '10', '20', '45', '90', '120', ' 30', '30 ', '30.0', 'thirty', 30]) {
      expectInvalid(publicWith({ R1_MEET_PUBLIC_SLOT_STEP_MINUTES: bad }), STEP_REASON, String(bad));
    }
  });

  it.each([
    ['R1_MEET_PUBLIC_REQUIRE_R1_STAGE', false, (c: PublicOn) => c.requireR1Stage],
    ['R1_MEET_PUBLIC_PRESLOT_RECHECK', true, (c: PublicOn) => c.preSlotRecheck],
  ] as const)('%s: blank = %s; exactly "true" or "false"; anything else is invalid', (name, fallback, read) => {
    for (const blank of [undefined, '']) expect(read(on(publicWith({ [name]: blank })))).toBe(fallback);
    expect(read(on(publicWith({ [name]: 'true' })))).toBe(true);
    expect(read(on(publicWith({ [name]: 'false' })))).toBe(false);
    for (const bad of ['TRUE', 'False', ' true', 'false ', 'yes', 'no', '1', '0', 'on', true, false]) {
      expectInvalid(publicWith({ [name]: bad }), boolReason(name), `${name}=${String(bad)}`);
    }
  });
});

describe('M035 public booking configuration: hours, days and closed dates', () => {
  it.each([
    ['the default', undefined, {}, [540, 1230]],
    ['blank', '', {}, [540, 1230]],
    ['the default spelled out', '09:00-20:30', {}, [540, 1230]],
    ['a single start', '09:00-09:00', {}, [540, 540]],
    ['a later window', '10:30-18:00', {}, [630, 1080]],
    ['15-minute step, 45-minute slot ending at midnight', '09:00-23:15', { R1_MEET_PUBLIC_SLOT_STEP_MINUTES: '15' }, [540, 1395]],
    ['60-minute slots ending at midnight', '09:00-23:00', { R1_MEET_PUBLIC_SLOT_MINUTES: '60', R1_MEET_PUBLIC_SLOT_STEP_MINUTES: '60' }, [540, 1380]],
    ['30-minute slots ending at midnight', '09:00-23:30', { R1_MEET_PUBLIC_SLOT_MINUTES: '30' }, [540, 1410]],
  ] as const)('R1_MEET_PUBLIC_HOURS_IST accepts %s', (_label, hours, extra, [first, last]) => {
    const config = on(publicWith({ ...extra, R1_MEET_PUBLIC_HOURS_IST: hours }));
    expect([config.slot.firstStartMinuteIst, config.slot.lastStartMinuteIst]).toEqual([first, last]);
  });

  it.each([
    ['a start before 09:00', '08:30-20:30', {}],
    ['the last start before the first', '10:00-09:30', {}],
    ['a one-digit hour', '9:00-20:30', {}],
    ['off the 30-minute grid', '09:15-20:30', {}],
    ['a 45-minute slot ending after midnight', '09:00-23:30', {}],
    ['the default hours on a 60-minute grid', undefined, { R1_MEET_PUBLIC_SLOT_STEP_MINUTES: '60' }],
    ['a 60-minute slot ending after midnight', '09:00-23:30', { R1_MEET_PUBLIC_SLOT_MINUTES: '60' }],
    ['hour 24', '09:00-24:00', {}],
    ['minute 60', '09:00-20:60', {}],
    ['spaces around the dash', '09:00 - 20:30', {}],
    ['a trailing space', '09:00-20:30 ', {}],
    ['no colons', '0900-2030', {}],
    ['one time only', '09:00', {}],
    ['non-ASCII digits', '٠٩:00-20:30', {}],
    ['a non-string', 930, {}],
  ] as const)('R1_MEET_PUBLIC_HOURS_IST rejects %s', (_label, hours, extra) => {
    expectInvalid(publicWith({ ...extra, R1_MEET_PUBLIC_HOURS_IST: hours }), HOURS_REASON);
  });

  it.each([
    [undefined, [1, 2, 3, 4, 5, 6, 7]],
    ['', [1, 2, 3, 4, 5, 6, 7]],
    ['mon-sun', [1, 2, 3, 4, 5, 6, 7]],
    ['mon-fri', [1, 2, 3, 4, 5]],
    ['MON,wed', [1, 3]],
    ['sat-sun,mon', [1, 6, 7]],
    [' mon , Tue ', [1, 2]],
    ['mon-mon', [1]],
    ['fri,mon-wed,tue', [1, 2, 3, 5]],
    ['sun', [7]],
  ] as const)('R1_MEET_PUBLIC_DAYS=%j is %j (sorted, unique ISO weekdays)', (days, expected) => {
    const config = on(publicWith({ R1_MEET_PUBLIC_DAYS: days }));
    expect(config.slot.isoWeekdays).toEqual(expected);
    expect(Object.isFrozen(config.slot.isoWeekdays)).toBe(true);
  });

  it('R1_MEET_PUBLIC_DAYS rejects descending ranges, empty items and unknown days', () => {
    for (const bad of ['fri-mon', 'sun-mon', 'mon,', ',mon', 'mon,,tue', 'funday', 'monday', 'mo', 'mon-', '-fri', 'mon - fri', 'mon;tue', 'mon-tue-wed', ' ', 7]) {
      expectInvalid(publicWith({ R1_MEET_PUBLIC_DAYS: bad }), DAYS_REASON, String(bad));
    }
  });

  it('R1_MEET_PUBLIC_CLOSED_DATES: blank = none; real dates, trimmed, sorted and de-duplicated', () => {
    for (const blank of [undefined, '']) expect(on(publicWith({ R1_MEET_PUBLIC_CLOSED_DATES: blank })).slot.closedDates).toEqual([]);
    const config = on(publicWith({ R1_MEET_PUBLIC_CLOSED_DATES: '2026-12-25, 2026-01-26 ,2026-12-25,2028-02-29,2000-02-29' }));
    expect(config.slot.closedDates).toEqual(['2000-02-29', '2026-01-26', '2026-12-25', '2028-02-29']);
    expect(Object.isFrozen(config.slot.closedDates)).toBe(true);
    // At most 100 items, counted BEFORE de-duplication.
    const hundred = Array.from({ length: 100 }, () => '2026-12-25').join(',');
    expect(on(publicWith({ R1_MEET_PUBLIC_CLOSED_DATES: hundred })).slot.closedDates).toEqual(['2026-12-25']);
    const distinct = Array.from({ length: 100 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10));
    expect(on(publicWith({ R1_MEET_PUBLIC_CLOSED_DATES: distinct.reverse().join(',') })).slot.closedDates).toHaveLength(100);
  });

  it('R1_MEET_PUBLIC_CLOSED_DATES rejects unreal dates, bad shapes, empty items and 101 items', () => {
    const bad: unknown[] = [
      '2026-02-30',
      '2026-02-29',
      '1900-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '2026-4-01',
      '26-04-01',
      '2026/04/01',
      '2026-04-01T00:00',
      '2026-04-01,',
      ',2026-04-01',
      '2026-04-01,,2026-04-02',
      ' ',
      Array.from({ length: 101 }, () => '2026-12-25').join(','),
      20261225,
    ];
    for (const value of bad) expectInvalid(publicWith({ R1_MEET_PUBLIC_CLOSED_DATES: value }), CLOSED_REASON, String(value).slice(0, 40));
  });
});

// ── check order ────────────────────────────────────────────────────────────────────────────────────

/** The knobs in check order (contract §2 table order), each with a bad value and its reason. */
const KNOB_ORDER: readonly (readonly [string, string, string])[] = [
  ['R1_MEET_GOOGLE_AUTH_MODE', 'dwd', AUTH_MODE_REASON],
  ['R1_MEET_GOOGLE_MEET_MODE', 'zoom', MEET_MODE_REASON],
  ['R1_MEET_PUBLIC_SLOT_MINUTES', '0', intReason('R1_MEET_PUBLIC_SLOT_MINUTES', 30, 60)],
  ['R1_MEET_PUBLIC_SLOT_STEP_MINUTES', '7', STEP_REASON],
  ['R1_MEET_PUBLIC_HOURS_IST', '08:00-20:30', HOURS_REASON],
  ['R1_MEET_PUBLIC_DAYS', 'funday', DAYS_REASON],
  ['R1_MEET_PUBLIC_CLOSED_DATES', '2026-02-30', CLOSED_REASON],
  ['R1_MEET_PUBLIC_MIN_NOTICE_MINUTES', '29', intReason('R1_MEET_PUBLIC_MIN_NOTICE_MINUTES', 30, 1440)],
  ['R1_MEET_PUBLIC_HORIZON_DAYS', '14', intReason('R1_MEET_PUBLIC_HORIZON_DAYS', 1, 13)],
  ['R1_MEET_PUBLIC_SLOT_CAPACITY', '16', intReason('R1_MEET_PUBLIC_SLOT_CAPACITY', 1, 15)],
  ['R1_MEET_PUBLIC_BROWSER_HEADROOM', '15', intReason('R1_MEET_PUBLIC_BROWSER_HEADROOM', 0, 14)],
  ['R1_MEET_PUBLIC_DAILY_CAP', '201', intReason('R1_MEET_PUBLIC_DAILY_CAP', 1, 200)],
  ['R1_MEET_PUBLIC_MAX_MOVES', '11', intReason('R1_MEET_PUBLIC_MAX_MOVES', 0, 10)],
  ['R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES', '14', intReason('R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES', 15, 720)],
  ['R1_MEET_PUBLIC_REQUIRE_R1_STAGE', 'yes', boolReason('R1_MEET_PUBLIC_REQUIRE_R1_STAGE')],
  ['R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS', '366', intReason('R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS', 1, 365)],
  ['R1_MEET_PUBLIC_PRESLOT_RECHECK', 'no', boolReason('R1_MEET_PUBLIC_PRESLOT_RECHECK')],
];

describe('M035 public booking configuration: check order', () => {
  it('reports each bad knob alone', () => {
    for (const [name, bad, reason] of KNOB_ORDER) expectInvalid(publicWith({ [name]: bad }), reason, name);
  });

  it('with two bad knobs, the earlier one in table order is the reason', () => {
    for (let i = 0; i < KNOB_ORDER.length; i += 1) {
      for (let j = i + 1; j < KNOB_ORDER.length; j += 1) {
        const [first, firstBad, reason] = KNOB_ORDER[i]!;
        const [second, secondBad] = KNOB_ORDER[j]!;
        expectInvalid(publicWith({ [first]: firstBad, [second]: secondBad }), reason, `${first} + ${second}`);
      }
    }
  });

  it('checks every knob before the Meet dependency, the service user and the Google values', () => {
    const allBad = Object.fromEntries(KNOB_ORDER.map(([name, bad]) => [name, bad]));
    const broken = {
      ...allBad,
      R1_MEET_PUBLIC_BOOKING_ENABLED: 'true',
      R1_MEET_ENABLED: 'yes',
      R1_MEET_GOOGLE_DEX_EMAIL: 'nope',
    } as R1MeetEnvSource;
    expectInvalid(getR1MeetPublicConfig(broken), AUTH_MODE_REASON);
    expectInvalid(getR1MeetPublicConfig({ ...broken, R1_MEET_GOOGLE_AUTH_MODE: undefined }), MEET_MODE_REASON);
    // No knob failed after Meet was consulted: the Meet reader was never called, so it logged nothing.
    expect(logged).toEqual([]);
  });

  it('then needs the Meet configuration enabled: disabled or invalid gives the Meet reason', () => {
    expectInvalid(publicWith({ R1_MEET_ENABLED: undefined }), MEET_REASON);
    expectInvalid(publicWith({ R1_MEET_ENABLED: 'false' }), MEET_REASON);
    expect(logged).toEqual([]);
    // Meet invalid: the public reason is the Meet reason; Meet logs ITS OWN line once, as always.
    expectInvalid(publicWith({ R1_MEET_ENABLED: 'yes' }), MEET_REASON);
    expectInvalid(publicWith({ R1_MEET_DAILY_BOT_CAP: '0' }), MEET_REASON);
    expectInvalid(publicWith({ RECALL_API_KEY: undefined }), MEET_REASON);
    expect(logged).toHaveLength(3);
    for (const line of logged) expect(line.startsWith('[r1-meet-config] Meet off: ')).toBe(true);
    // Meet beats the service user and every Google value.
    expectInvalid(
      publicWith({ R1_MEET_ENABLED: undefined, R1_MEET_SERVICE_USER_ID: undefined, R1_MEET_GOOGLE_DEX_EMAIL: undefined }),
      MEET_REASON,
    );
  });

  it('then needs R1_MEET_SERVICE_USER_ID (it owns the public rounds)', () => {
    for (const blank of [undefined, '']) {
      expectInvalid(publicWith({ R1_MEET_SERVICE_USER_ID: blank }), SERVICE_REASON, String(blank));
    }
    expectInvalid(publicWith({ R1_MEET_SERVICE_USER_ID: undefined, R1_MEET_GOOGLE_DEX_EMAIL: undefined }), SERVICE_REASON);
    expect(logged).toEqual([]);
  });

  it('then Dex email and the OAuth credentials present, in order', () => {
    const missing = { R1_MEET_GOOGLE_OAUTH_CLIENT_ID: undefined, R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: undefined, R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: undefined };
    expectInvalid(publicWith({ ...missing, R1_MEET_GOOGLE_DEX_EMAIL: undefined }), DEX_REQUIRED);
    expectInvalid(publicWith({ R1_MEET_GOOGLE_DEX_EMAIL: '' }), DEX_REQUIRED);
    expectInvalid(publicWith(missing), credRequired('R1_MEET_GOOGLE_OAUTH_CLIENT_ID', 'oauth_refresh'));
    expectInvalid(
      publicWith({ ...missing, R1_MEET_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID_VALUE }),
      credRequired('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', 'oauth_refresh'),
    );
    expectInvalid(
      publicWith({ R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: '' }),
      credRequired('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', 'oauth_refresh'),
    );
    // The default auth mode is named in the reason too.
    expectInvalid(
      publicWith({ R1_MEET_GOOGLE_AUTH_MODE: 'oauth_refresh', R1_MEET_GOOGLE_OAUTH_CLIENT_ID: undefined }),
      credRequired('R1_MEET_GOOGLE_OAUTH_CLIENT_ID', 'oauth_refresh'),
    );
  });

  it('presence is checked for all before well-formedness: a missing value beats a malformed one', () => {
    expectInvalid(
      publicWith({ R1_MEET_GOOGLE_DEX_EMAIL: 'nope', R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: undefined }),
      credRequired('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', 'oauth_refresh'),
    );
    expectInvalid(
      publicWith({ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'nope', R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: undefined }),
      credRequired('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', 'oauth_refresh'),
    );
  });

  it('then each well formed, in the same order', () => {
    const bad = {
      R1_MEET_GOOGLE_DEX_EMAIL: 'nope',
      R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'nope',
      R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'a b',
      R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: 'a b',
    };
    expectInvalid(publicWith(bad), DEX_MALFORMED);
    expectInvalid(publicWith({ ...bad, R1_MEET_GOOGLE_DEX_EMAIL: DEX_EMAIL }), CLIENT_ID_MALFORMED);
    expectInvalid(
      publicWith({ ...bad, R1_MEET_GOOGLE_DEX_EMAIL: DEX_EMAIL, R1_MEET_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID_VALUE }),
      CS_MALFORMED,
    );
    expectInvalid(publicWith({ R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: 'a b' }), RT_MALFORMED);
  });

  it('counts replace_me as unset in the three secret slots only', () => {
    expectInvalid(
      publicWith({ R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'replace_me' }),
      credRequired('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', 'oauth_refresh'),
    );
    expectInvalid(
      publicWith({ R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: 'replace_me' }),
      credRequired('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', 'oauth_refresh'),
    );
    expectInvalid(
      getR1MeetPublicConfig(saValid({ R1_MEET_GOOGLE_SA_KEY_B64: 'replace_me' })),
      credRequired('R1_MEET_GOOGLE_SA_KEY_B64', 'service_account'),
    );
    // The client id and the Dex email are not secrets: the placeholder there is just malformed.
    expectInvalid(publicWith({ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'replace_me' }), CLIENT_ID_MALFORMED);
    expectInvalid(publicWith({ R1_MEET_GOOGLE_DEX_EMAIL: 'replace_me' }), DEX_MALFORMED);
  });
});

// ── Google values ──────────────────────────────────────────────────────────────────────────────────

describe('M035 public booking configuration: Dex email, client id, secret and refresh token', () => {
  it('lower-cases the Dex email', () => {
    expect(on(publicWith({ R1_MEET_GOOGLE_DEX_EMAIL: 'Dex@Hello.Example.TEST' })).google.dexEmail).toBe(DEX_EMAIL);
    const longest = 'd'.repeat(254 - '@hello.example.test'.length) + '@hello.example.test';
    expect(longest).toHaveLength(254);
    expect(on(publicWith({ R1_MEET_GOOGLE_DEX_EMAIL: longest })).google.dexEmail).toBe(longest);
  });

  it('rejects anything that is not one plain email address of at most 254 characters', () => {
    const bad: unknown[] = [
      'dex',
      'dex@',
      '@hello.example.test',
      'dex@hello',
      'dex@@hello.example.test',
      'dex@hel@lo.example.test',
      ' dex@hello.example.test',
      'dex@hello.example.test ',
      'dex @hello.example.test',
      'dex@hello.example.test\n',
      'dex\t@hello.example.test',
      'dex@.hello',
      'dex@hello.',
      'Dex <dex@hello.example.test>',
      'dex@hello.example.test,hr@hello.example.test',
      'dex;x@hello.example.test',
      'déx@hello.example.test',
      'dex​@hello.example.test',
      'd'.repeat(255 - '@hello.example.test'.length) + '@hello.example.test',
      42,
      {},
    ];
    for (const value of bad) expectInvalid(publicWith({ R1_MEET_GOOGLE_DEX_EMAIL: value }), DEX_MALFORMED, JSON.stringify(value));
  });

  it('the OAuth client id must end with .apps.googleusercontent.com, at most 200 characters', () => {
    const longest = 'a'.repeat(200 - GOOGLE_SUFFIX.length) + GOOGLE_SUFFIX;
    expect(longest).toHaveLength(200);
    for (const id of [longest, `1234-abc_def.x${GOOGLE_SUFFIX}`, `a${GOOGLE_SUFFIX}`]) {
      expect(oauth(on(publicWith({ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: id })).google).clientId).toBe(id);
    }
    const bad: unknown[] = [
      'a'.repeat(201 - GOOGLE_SUFFIX.length) + GOOGLE_SUFFIX,
      GOOGLE_SUFFIX,
      'abc.apps.googleusercontent.com.evil.test',
      'abc.APPS.GOOGLEUSERCONTENT.COM',
      'abc.example.test',
      ` abc${GOOGLE_SUFFIX}`,
      `abc${GOOGLE_SUFFIX} `,
      `a b${GOOGLE_SUFFIX}`,
      `a/b${GOOGLE_SUFFIX}`,
      7,
    ];
    for (const value of bad) expectInvalid(publicWith({ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: value }), CLIENT_ID_MALFORMED, String(value));
  });

  it.each([
    ['R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', 200, CS_MALFORMED, (g: OAuthSettings) => g.clientSecret],
    ['R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', 512, RT_MALFORMED, (g: OAuthSettings) => g.refreshToken],
  ] as const)('%s: 1..%d printable ASCII, no whitespace', (name, max, reason, read) => {
    for (const value of ['!', '~'.repeat(max), 'x'.repeat(max), 'a.b-c_d/e+f=g']) {
      expect(read(oauth(on(publicWith({ [name]: value })).google)), `${value.length}`).toBe(value);
    }
    for (const value of ['x'.repeat(max + 1), 'a b', ' abc', 'abc ', 'a\tb', 'a\nb', 'café', 'a\u0000b', 7, {}]) {
      expectInvalid(publicWith({ [name]: value }), reason, JSON.stringify(value)?.slice(0, 20));
    }
  });
});

describe('M035 public booking configuration: the service_account mode (dedicated Dex Workspace only)', () => {
  it('is on with a key built at run time: the email is visible, the key id and PEM readable by name only', () => {
    const config = on(getR1MeetPublicConfig(saValid()));
    const google = serviceAccount(config.google);
    expect(google).toStrictEqual({ authMode: 'service_account', dexEmail: DEX_EMAIL, clientEmail: SA_EMAIL });
    expect(Object.keys(google)).toEqual(['authMode', 'dexEmail', 'clientEmail']);
    expect(google.privateKeyId).toBe(KID);
    expect(google.privateKey).toBe(PEM);
    expect(Object.getOwnPropertyDescriptor(google, 'privateKey')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(google, 'privateKeyId')?.enumerable).toBe(false);
    expect(Object.isFrozen(google)).toBe(true);
    expect(logged).toEqual([]);
  });

  it('accepts unpadded base64 and a decoded key of exactly 8 KB', () => {
    const unpadded = saKey().replace(/=+$/, '');
    expect(serviceAccount(on(getR1MeetPublicConfig(saValid({ R1_MEET_GOOGLE_SA_KEY_B64: unpadded }))).google).privateKey).toBe(PEM);
    const base = JSON.stringify(saJson({ filler: '' })).length;
    const exact = JSON.stringify(saJson({ filler: 'x'.repeat(R1_MEET_GOOGLE_SA_KEY_MAX_BYTES - base) }));
    expect(Buffer.byteLength(exact)).toBe(8192);
    expect(on(getR1MeetPublicConfig(saValid({ R1_MEET_GOOGLE_SA_KEY_B64: b64(exact) }))).google.authMode).toBe('service_account');
    const over = JSON.stringify(saJson({ filler: 'x'.repeat(R1_MEET_GOOGLE_SA_KEY_MAX_BYTES - base + 1) }));
    expectInvalid(getR1MeetPublicConfig(saValid({ R1_MEET_GOOGLE_SA_KEY_B64: b64(over) })), SA_MALFORMED);
  });

  it('rejects every malformed key with the one SA reason', () => {
    const lines = PEM.trim().split('\n');
    // A valid key JSON with one extra string field holding two bytes that are not UTF-8.
    const invalidUtf8 = Buffer.concat([
      Buffer.from(JSON.stringify(saJson()).slice(0, -1) + ',"note":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}'),
    ]);
    const bad: [string, unknown][] = [
      ['not base64', '%%%'],
      ['base64url alphabet', saKey().replace(/\+/g, '-').replace(/\//g, '_') + '-_'],
      ['wrapped lines', saKey().replace(/(.{76})/g, '$1\n')],
      ['padding in the middle', 'QQ==QQ=='],
      ['a one-character tail', 'QUJDREVG' + 'Q'],
      ['wrong padding length', 'QUJD='],
      ['not JSON', b64('hello there')],
      ['a JSON array', b64(JSON.stringify([saJson()]))],
      ['JSON null', b64('null')],
      ['a JSON string', b64(JSON.stringify(saKey()))],
      ['invalid UTF-8', b64(invalidUtf8)],
      ['type user', saKey({ type: 'authorized_user' })],
      ['no type', saKey({}, ['type'])],
      ['no client_email', saKey({}, ['client_email'])],
      ['client_email without @', saKey({ client_email: 'hello-r1-dwd.example.test' })],
      ['client_email with two @', saKey({ client_email: 'a@b@hello.example.test' })],
      ['client_email with a space', saKey({ client_email: 'a b@hello.example.test' })],
      ['client_email not a string', saKey({ client_email: 7 })],
      ['no private_key', saKey({}, ['private_key'])],
      ['private_key not a string', saKey({ private_key: 7 })],
      ['private_key without the PKCS#8 header', saKey({ private_key: lines.slice(1).join('\n') })],
      ['private_key without the footer', saKey({ private_key: lines.slice(0, -1).join('\n') })],
      ['private_key with the footer first', saKey({ private_key: [lines.at(-1), ...lines.slice(1, -1), lines[0]].join('\n') })],
      ['a PKCS#1 private_key', saKey({ private_key: PKCS1_PEM })],
      ['no private_key_id', saKey({}, ['private_key_id'])],
      ['private_key_id with a slash', saKey({ private_key_id: 'kid/1' })],
      ['private_key_id too long', saKey({ private_key_id: 'k'.repeat(129) })],
      ['private_key_id empty', saKey({ private_key_id: '' })],
      ['far too long', 'Q'.repeat(20_000)],
      ['a non-string', 7],
    ];
    for (const [label, value] of bad) {
      expectInvalid(getR1MeetPublicConfig(saValid({ R1_MEET_GOOGLE_SA_KEY_B64: value as string })), SA_MALFORMED, label);
    }
    expect(logged).toEqual([]);
  });

  it('still needs the Dex email first, then the key', () => {
    expectInvalid(
      getR1MeetPublicConfig(saValid({ R1_MEET_GOOGLE_DEX_EMAIL: undefined, R1_MEET_GOOGLE_SA_KEY_B64: undefined })),
      DEX_REQUIRED,
    );
    expectInvalid(
      getR1MeetPublicConfig(saValid({ R1_MEET_GOOGLE_SA_KEY_B64: undefined })),
      credRequired('R1_MEET_GOOGLE_SA_KEY_B64', 'service_account'),
    );
    expectInvalid(getR1MeetPublicConfig(saValid({ R1_MEET_GOOGLE_DEX_EMAIL: 'nope', R1_MEET_GOOGLE_SA_KEY_B64: '%%%' })), DEX_MALFORMED);
  });

  it('ignores the other mode\'s variables in both directions, even malformed', () => {
    const sa = on(
      getR1MeetPublicConfig(
        saValid({
          R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'nope',
          R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'a b',
          R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: 'a b',
        }),
      ),
    );
    expect(sa.google.authMode).toBe('service_account');
    const viaOAuth = on(publicWith({ R1_MEET_GOOGLE_SA_KEY_B64: '%%%' }));
    expect(viaOAuth.google.authMode).toBe('oauth_refresh');

    for (const [label, source, unread] of [
      ['oauth', pubValid(), ['R1_MEET_GOOGLE_SA_KEY_B64']],
      [
        'service_account',
        saValid(),
        [
          'R1_MEET_GOOGLE_OAUTH_CLIENT_ID',
          'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET',
          'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN',
        ],
      ],
    ] as const) {
      const reads: string[] = [];
      const proxy = new Proxy(source, {
        get(target, name) {
          reads.push(String(name));
          return target[name as keyof R1MeetEnvSource];
        },
      });
      expect(getR1MeetPublicConfig(proxy).status, label).toBe('on');
      for (const name of unread) expect(reads, `${label}: ${name}`).not.toContain(name);
      // Every public variable of the chosen mode is read (literal reads, nothing skipped by accident).
      const expected = R1_MEET_PUBLIC_ENV_VARIABLES.filter((name) => !(unread as readonly string[]).includes(name));
      for (const name of expected) expect(reads, `${label}: ${name}`).toContain(name);
    }
  });

  it('settings the reader accepts are settings the token sources accept (no network at construction)', () => {
    const transport = async (): Promise<never> => {
      throw new Error('no network in this test');
    };
    const scopes = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings];
    const viaOAuth = oauth(on(getR1MeetPublicConfig(pubValid())).google);
    expect(() =>
      createGoogleOAuthRefreshTokenSource({
        clientId: viaOAuth.clientId,
        clientSecret: viaOAuth.clientSecret,
        refreshToken: viaOAuth.refreshToken,
        scopes,
        transport,
      }),
    ).not.toThrow();
    const viaKey = serviceAccount(on(getR1MeetPublicConfig(saValid())).google);
    expect(() =>
      createGoogleDwdTokenSource({
        key: { clientEmail: viaKey.clientEmail, privateKeyId: viaKey.privateKeyId, privateKey: viaKey.privateKey },
        subject: viaKey.dexEmail,
        scopes,
        transport,
      }),
    ).not.toThrow();
  });
});

// ── secrecy, never throws, independence ────────────────────────────────────────────────────────────

describe('M035 public booking configuration: secrecy', () => {
  it('keeps every credential out of every enumeration, in both modes, and freezes everything', () => {
    for (const config of [on(getR1MeetPublicConfig(pubValid())), on(getR1MeetPublicConfig(saValid()))]) {
      const text = [
        JSON.stringify(config),
        JSON.stringify(config.google),
        JSON.stringify({ ...config }),
        JSON.stringify({ ...config.google }),
        JSON.stringify(Object.entries(config.google)),
        JSON.stringify(Object.values(config.google)),
        JSON.stringify(Object.values(config)),
        Object.keys(config.google).join(','),
      ].join('\n');
      for (const secret of [CS_VALUE, RT_VALUE, PEM, KID, ARMOUR_WORD, RECALL_KEY_VALUE, RECALL_WEBHOOK_VALUE]) {
        expect(text, secret.slice(0, 12)).not.toContain(secret);
      }
      for (const frozen of [config, config.google, config.slot, config.slot.isoWeekdays, config.slot.closedDates]) {
        expect(Object.isFrozen(frozen)).toBe(true);
      }
      expect(() => {
        (config.google as { dexEmail: string }).dexEmail = 'other@hello.example.test';
      }).toThrow(TypeError);
      expect(() => {
        (config.slot.isoWeekdays as number[]).push(8);
      }).toThrow(TypeError);
      expect(() => {
        (config as { status: string }).status = 'off';
      }).toThrow(TypeError);
    }
    const google = oauth(on(getR1MeetPublicConfig(pubValid())).google);
    expect(() => {
      (google as { refreshToken: string }).refreshToken = 'replaced';
    }).toThrow(TypeError);
    expect(google.refreshToken).toBe(RT_VALUE);
  });

  it('never puts a configured value in a reason, and never logs', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ R1_MEET_PUBLIC_BOOKING_ENABLED: 'canary-flag' }, 'canary-flag'],
      [{ R1_MEET_GOOGLE_AUTH_MODE: 'canary-auth' }, 'canary-auth'],
      [{ R1_MEET_GOOGLE_MEET_MODE: 'canary-meet' }, 'canary-meet'],
      [{ R1_MEET_PUBLIC_SLOT_MINUTES: '987654' }, '987654'],
      [{ R1_MEET_PUBLIC_SLOT_STEP_MINUTES: '987653' }, '987653'],
      [{ R1_MEET_PUBLIC_HOURS_IST: 'canary-hours' }, 'canary-hours'],
      [{ R1_MEET_PUBLIC_DAYS: 'canary-days' }, 'canary-days'],
      [{ R1_MEET_PUBLIC_CLOSED_DATES: 'canary-date' }, 'canary-date'],
      [{ R1_MEET_PUBLIC_MIN_NOTICE_MINUTES: '987652' }, '987652'],
      [{ R1_MEET_PUBLIC_HORIZON_DAYS: '987651' }, '987651'],
      [{ R1_MEET_PUBLIC_SLOT_CAPACITY: '987650' }, '987650'],
      [{ R1_MEET_PUBLIC_BROWSER_HEADROOM: '987649' }, '987649'],
      [{ R1_MEET_PUBLIC_DAILY_CAP: '987648' }, '987648'],
      [{ R1_MEET_PUBLIC_MAX_MOVES: '987647' }, '987647'],
      [{ R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES: '987646' }, '987646'],
      [{ R1_MEET_PUBLIC_REQUIRE_R1_STAGE: 'canary-stage' }, 'canary-stage'],
      [{ R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS: '987645' }, '987645'],
      [{ R1_MEET_PUBLIC_PRESLOT_RECHECK: 'canary-recheck' }, 'canary-recheck'],
      [{ R1_MEET_GOOGLE_DEX_EMAIL: 'canary-dex' }, 'canary-dex'],
      [{ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'canary-client' }, 'canary-client'],
      [{ R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: `${CS_VALUE} ` }, CS_VALUE],
      [{ R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: `${RT_VALUE} ` }, RT_VALUE],
      [{ R1_MEET_GOOGLE_AUTH_MODE: 'service_account', R1_MEET_GOOGLE_SA_KEY_B64: 'canary-sa' }, 'canary-sa'],
    ];
    for (const [extra, canary] of cases) {
      const config = publicWith(extra);
      if (config.status !== 'invalid') throw new Error(`expected invalid for ${canary}`);
      expect(config.reason, canary).not.toContain(canary);
      for (const secret of [CS_VALUE, RT_VALUE, DEX_EMAIL, CLIENT_ID_VALUE, WEB, SERVICE_ID]) {
        expect(config.reason).not.toContain(secret);
      }
    }
    // Silent: the caller raises r1_meet_public_setup_error with the reason.
    expect(logged).toEqual([]);
  });
});

describe('M035 public booking configuration: never throws, never touches the Meet answer', () => {
  it('never throws, even when the source itself throws, and stays silent', () => {
    const throwingAt = (name: string): R1MeetEnvSource => {
      const source = pubValid();
      Object.defineProperty(source, name, {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      return source;
    };
    const throwingEverywhere = new Proxy({} as R1MeetEnvSource, {
      get() {
        throw new Error('boom');
      },
    });
    const sources = [
      throwingAt('R1_MEET_PUBLIC_BOOKING_ENABLED'),
      throwingAt('R1_MEET_PUBLIC_HOURS_IST'),
      throwingAt('R1_MEET_GOOGLE_DEX_EMAIL'),
      throwingAt('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN'),
      throwingEverywhere,
    ];
    for (const source of sources) {
      let result: R1MeetPublicConfig | undefined;
      expect(() => {
        result = getR1MeetPublicConfig(source);
      }).not.toThrow();
      expectInvalid(result!, UNEXPECTED_REASON);
    }
    expect(logged).toEqual([]);
    // A throwing Meet value is the Meet reader's business: it reports its own reason, and the public
    // reader answers with the Meet reason.
    expectInvalid(getR1MeetPublicConfig(throwingAt('RECALL_API_KEY')), MEET_REASON);
    expect(logged).toEqual(['[r1-meet-config] Meet off: unexpected error while reading the Meet configuration']);
  });

  it('a bad public value leaves getR1MeetConfig enabled and unchanged', () => {
    const base = meetValid({ R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID });
    const expected = getR1MeetConfig(base);
    expect(expected.status).toBe('enabled');
    const rows: Record<string, unknown>[] = [
      ...KNOB_ORDER.map(([name, bad]) => ({ R1_MEET_PUBLIC_BOOKING_ENABLED: 'true', [name]: bad })),
      { R1_MEET_PUBLIC_BOOKING_ENABLED: 'yes' },
      { ...MALFORMED_PUBLIC, R1_MEET_PUBLIC_BOOKING_ENABLED: 'true' },
    ];
    for (const row of rows) {
      const source = { ...base, ...row } as R1MeetEnvSource;
      expect(getR1MeetPublicConfig(source).status).toBe('invalid');
      const meet = getR1MeetConfig(source);
      expect(meet).toStrictEqual(expected);
      if (meet.enabled && expected.enabled) {
        expect([meet.recall.apiKey, meet.recall.webhookSecret]).toEqual([expected.recall.apiKey, expected.recall.webhookSecret]);
      }
    }
    expect(logged).toEqual([]);
  });
});

// ── process.env (the production path) ──────────────────────────────────────────────────────────────

describe('M035 public booking configuration: process.env', () => {
  const MEET_ENV: Record<string, string> = {
    R1_MEET_ENABLED: 'true',
    R1_MEET_ASHBY_DEX_USER_ID: DEX_ID,
    R1_MEET_SERVICE_USER_ID: SERVICE_ID,
    RECALL_API_KEY: RECALL_KEY_VALUE,
    RECALL_WEBHOOK_SECRET: RECALL_WEBHOOK_VALUE,
    WEB_ORIGIN: WEB,
  };
  /** Every public variable set to a NON-default valid value, so each read is visible. */
  const PUBLIC_ENV: Record<string, string> = {
    R1_MEET_PUBLIC_BOOKING_ENABLED: 'true',
    R1_MEET_GOOGLE_AUTH_MODE: 'oauth_refresh',
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID_VALUE,
    R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: CS_VALUE,
    R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: RT_VALUE,
    R1_MEET_GOOGLE_SA_KEY_B64: '',
    R1_MEET_GOOGLE_DEX_EMAIL: 'DEX@hello.example.test',
    R1_MEET_GOOGLE_MEET_MODE: 'space',
    R1_MEET_PUBLIC_SLOT_MINUTES: '60',
    R1_MEET_PUBLIC_SLOT_STEP_MINUTES: '15',
    R1_MEET_PUBLIC_HOURS_IST: '09:15-21:45',
    R1_MEET_PUBLIC_DAYS: 'mon-fri',
    R1_MEET_PUBLIC_CLOSED_DATES: '2026-12-25,2026-12-24',
    R1_MEET_PUBLIC_MIN_NOTICE_MINUTES: '120',
    R1_MEET_PUBLIC_HORIZON_DAYS: '13',
    R1_MEET_PUBLIC_SLOT_CAPACITY: '15',
    R1_MEET_PUBLIC_BROWSER_HEADROOM: '3',
    R1_MEET_PUBLIC_DAILY_CAP: '50',
    R1_MEET_PUBLIC_MAX_MOVES: '0',
    R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES: '60',
    R1_MEET_PUBLIC_REQUIRE_R1_STAGE: 'true',
    R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS: '90',
    R1_MEET_PUBLIC_PRESLOT_RECHECK: 'false',
  };
  function stubAll(overrides: Record<string, string> = {}): void {
    for (const name of R1_MEET_ENV_VARIABLES) vi.stubEnv(name, '');
    for (const [name, value] of Object.entries({ ...MEET_ENV, ...PUBLIC_ENV, ...overrides })) vi.stubEnv(name, value);
  }

  it('the stub table covers every public variable', () => {
    expect(Object.keys(PUBLIC_ENV)).toEqual([...R1_MEET_PUBLIC_ENV_VARIABLES]);
  });

  it('reads every public variable from process.env when no source is passed', () => {
    stubAll();
    const config = on(getR1MeetPublicConfig());
    expect(config).toStrictEqual({
      status: 'on',
      google: { authMode: 'oauth_refresh', dexEmail: DEX_EMAIL, clientId: CLIENT_ID_VALUE },
      meetMode: 'space',
      botMode: 'guest',
      slot: {
        slotMinutes: 60,
        stepMinutes: 15,
        firstStartMinuteIst: 555,
        lastStartMinuteIst: 1305,
        isoWeekdays: [1, 2, 3, 4, 5],
        closedDates: ['2026-12-24', '2026-12-25'],
        minNoticeMinutes: 120,
        horizonDays: 13,
        slotCapacity: 15,
        browserHeadroom: 3,
        publicDailyCap: 50,
      },
      maxMoves: 0,
      manageCutoffMinutes: 60,
      requireR1Stage: true,
      calendarRetentionDays: 90,
      preSlotRecheck: false,
      serviceUserId: SERVICE_ID,
      dailyBotCap: 20,
      bookPageUrl: `${WEB}/book`,
      managePageUrl: `${WEB}/book/manage`,
    });
    const google = oauth(config.google);
    expect([google.clientSecret, google.refreshToken]).toEqual([CS_VALUE, RT_VALUE]);
    expect(logged).toEqual([]);
  });

  it('reads the service-account key from process.env, and the login group turns on the signed-in bot', () => {
    stubAll({
      R1_MEET_GOOGLE_AUTH_MODE: 'service_account',
      R1_MEET_GOOGLE_OAUTH_CLIENT_ID: '',
      R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: '',
      R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: '',
      R1_MEET_GOOGLE_LOGIN_GROUP_ID: GROUP_ID,
    });
    vi.stubEnv('R1_MEET_GOOGLE_SA_KEY_B64', saKey());
    const config = on(getR1MeetPublicConfig());
    expect(serviceAccount(config.google).privateKey).toBe(PEM);
    expect(config.botMode).toBe('signed_in');
  });

  it('is off by default: the flag blank in process.env', () => {
    stubAll({ R1_MEET_PUBLIC_BOOKING_ENABLED: '' });
    expect(getR1MeetPublicConfig()).toStrictEqual({ status: 'off' });
  });

  it.each([
    ['R1_MEET_PUBLIC_BOOKING_ENABLED', 'yes', {}, FLAG_REASON],
    ['R1_MEET_GOOGLE_AUTH_MODE', 'dwd', {}, AUTH_MODE_REASON],
    ['R1_MEET_GOOGLE_OAUTH_CLIENT_ID', 'nope', {}, CLIENT_ID_MALFORMED],
    ['R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', 'a b', {}, CS_MALFORMED],
    ['R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', 'a b', {}, RT_MALFORMED],
    ['R1_MEET_GOOGLE_SA_KEY_B64', '%%%', { R1_MEET_GOOGLE_AUTH_MODE: 'service_account' }, SA_MALFORMED],
    ['R1_MEET_GOOGLE_DEX_EMAIL', 'nope', {}, DEX_MALFORMED],
    ['R1_MEET_GOOGLE_MEET_MODE', 'zoom', {}, MEET_MODE_REASON],
    ...KNOB_ORDER.slice(2).map(([name, bad, reason]) => [name, bad, {}, reason] as const),
  ] as const)('reads %s from process.env', (name, bad, extra, reason) => {
    stubAll({ ...extra, [name]: bad });
    expectInvalid(getR1MeetPublicConfig(), reason);
  });
});

// ── r1MeetPublicActive ─────────────────────────────────────────────────────────────────────────────

describe('M035 public booking configuration: r1MeetPublicActive', () => {
  it('is true only when R1, Meet and the public configuration are all on', () => {
    const meetOn = getR1MeetConfig(meetValid());
    const meetOff = getR1MeetConfig({});
    const meetBad = getR1MeetConfig(meetValid({ R1_MEET_ENABLED: 'yes' }));
    const pubOn = getR1MeetPublicConfig(pubValid());
    const pubOff = getR1MeetPublicConfig({});
    const pubBad = getR1MeetPublicConfig(pubValid({ R1_MEET_PUBLIC_DAYS: 'funday' }));
    expect([meetOn.status, meetOff.status, pubOn.status, pubOff.status, pubBad.status]).toEqual([
      'enabled',
      'disabled',
      'on',
      'off',
      'invalid',
    ]);
    const table: [boolean, R1MeetConfig, R1MeetPublicConfig, boolean][] = [
      [true, meetOn, pubOn, true],
      [true, meetOn, pubOff, false],
      [true, meetOff, pubOn, false],
      [true, meetOff, pubOff, false],
      [false, meetOn, pubOn, false],
      [false, meetOn, pubOff, false],
      [false, meetOff, pubOn, false],
      [false, meetOff, pubOff, false],
      [true, meetOn, pubBad, false],
      [true, meetBad, pubOn, false],
    ];
    for (const [index, [r1, meet, pub, expected]] of table.entries()) {
      expect(r1MeetPublicActive({ enabled: r1 }, meet, pub), String(index)).toBe(expected);
    }
  });
});

// ── the Google half of the drain ───────────────────────────────────────────────────────────────────

describe('M035 public booking configuration: getR1MeetPublicDrainConfig', () => {
  const available = (source: R1MeetEnvSource): Extract<R1MeetPublicDrainConfig, { available: true }> => {
    const config = getR1MeetPublicDrainConfig(source);
    if (!config.available) throw new Error('expected an available Google drain config');
    return config;
  };
  const oauthOnly = (extra: R1MeetEnvSource = {}): R1MeetEnvSource => ({
    R1_MEET_GOOGLE_DEX_EMAIL: DEX_EMAIL,
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID_VALUE,
    R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: CS_VALUE,
    R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: RT_VALUE,
    ...extra,
  });

  it('is available with valid Google values whatever the flags and every other variable say', () => {
    const states: R1MeetEnvSource[] = [
      oauthOnly(),
      pubValid({ R1_MEET_PUBLIC_BOOKING_ENABLED: 'false' }),
      pubValid({ R1_MEET_PUBLIC_BOOKING_ENABLED: 'yes' }),
      pubValid({ R1_MEET_ENABLED: undefined }),
      pubValid({ R1_MEET_ENABLED: 'yes', R1_MEET_SERVICE_USER_ID: undefined }),
      pubValid({ R1_MEET_PUBLIC_DAYS: 'funday', R1_MEET_PUBLIC_HOURS_IST: 'nope' }),
    ];
    for (const [index, state] of states.entries()) {
      const google = oauth(available(state).google);
      expect(google, String(index)).toStrictEqual({ authMode: 'oauth_refresh', dexEmail: DEX_EMAIL, clientId: CLIENT_ID_VALUE });
      expect([google.clientSecret, google.refreshToken]).toEqual([CS_VALUE, RT_VALUE]);
    }
    const sa = serviceAccount(available(saValid({ R1_MEET_PUBLIC_BOOKING_ENABLED: undefined, R1_MEET_ENABLED: undefined })).google);
    expect([sa.clientEmail, sa.privateKeyId, sa.privateKey]).toEqual([SA_EMAIL, KID, PEM]);
    expect(logged).toEqual([]);
  });

  it('is unavailable when a value is missing, a placeholder or malformed, and says nothing', () => {
    const bad: R1MeetEnvSource[] = [
      {},
      oauthOnly({ R1_MEET_GOOGLE_DEX_EMAIL: undefined }),
      oauthOnly({ R1_MEET_GOOGLE_DEX_EMAIL: 'nope' }),
      oauthOnly({ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: undefined }),
      oauthOnly({ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'nope' }),
      oauthOnly({ R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'replace_me' }),
      oauthOnly({ R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'a b' }),
      oauthOnly({ R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: 'replace_me' }),
      oauthOnly({ R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: '' }),
      oauthOnly({ R1_MEET_GOOGLE_AUTH_MODE: 'dwd' }),
      oauthOnly({ R1_MEET_GOOGLE_AUTH_MODE: 'service_account' }),
      saValid({ R1_MEET_GOOGLE_SA_KEY_B64: 'replace_me' }),
      saValid({ R1_MEET_GOOGLE_SA_KEY_B64: '%%%' }),
    ];
    for (const [index, source] of bad.entries()) {
      const config = getR1MeetPublicDrainConfig(source);
      expect(config, String(index)).toStrictEqual({ available: false });
      expect(Object.isFrozen(config)).toBe(true);
    }
    expect(logged).toEqual([]);
  });

  it('reads only the auth mode, the Dex email and the chosen mode\'s credentials', () => {
    for (const [label, source, expected] of [
      [
        'oauth',
        pubValid(),
        [
          'R1_MEET_GOOGLE_AUTH_MODE',
          'R1_MEET_GOOGLE_DEX_EMAIL',
          'R1_MEET_GOOGLE_OAUTH_CLIENT_ID',
          'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET',
          'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN',
        ],
      ],
      ['service_account', saValid(), ['R1_MEET_GOOGLE_AUTH_MODE', 'R1_MEET_GOOGLE_DEX_EMAIL', 'R1_MEET_GOOGLE_SA_KEY_B64']],
    ] as const) {
      const reads: string[] = [];
      const proxy = new Proxy(source, {
        get(target, name) {
          reads.push(String(name));
          return target[name as keyof R1MeetEnvSource];
        },
      });
      expect(getR1MeetPublicDrainConfig(proxy).available, label).toBe(true);
      expect([...new Set(reads)].sort(), label).toEqual([...expected].sort());
    }
  });

  it('reads process.env when no source is passed, with every flag off', () => {
    for (const name of R1_MEET_ENV_VARIABLES) vi.stubEnv(name, '');
    vi.stubEnv('R1_MEET_GOOGLE_DEX_EMAIL', DEX_EMAIL);
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID_VALUE);
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', CS_VALUE);
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', RT_VALUE);
    const config = getR1MeetPublicDrainConfig();
    expect(config.available && oauth(config.google).refreshToken).toBe(RT_VALUE);
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', '');
    expect(getR1MeetPublicDrainConfig()).toStrictEqual({ available: false });
    vi.stubEnv('R1_MEET_GOOGLE_AUTH_MODE', 'service_account');
    vi.stubEnv('R1_MEET_GOOGLE_SA_KEY_B64', saKey());
    const viaKey = getR1MeetPublicDrainConfig();
    expect(viaKey.available && serviceAccount(viaKey.google).clientEmail).toBe(SA_EMAIL);
  });

  it('never throws, and keeps the secrets out of every enumeration', () => {
    const throwing = new Proxy({} as R1MeetEnvSource, {
      get() {
        throw new Error('boom');
      },
    });
    expect(getR1MeetPublicDrainConfig(throwing)).toStrictEqual({ available: false });
    for (const config of [available(oauthOnly()), available(saValid())]) {
      const text = [
        JSON.stringify(config),
        JSON.stringify({ ...config.google }),
        JSON.stringify(Object.entries(config.google)),
        Object.keys(config.google).join(','),
      ].join('\n');
      for (const secret of [CS_VALUE, RT_VALUE, PEM, KID, ARMOUR_WORD]) expect(text).not.toContain(secret);
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.google)).toBe(true);
    }
    expect(logged).toEqual([]);
  });
});

// ── the consent helper's inputs ────────────────────────────────────────────────────────────────────

describe('M035 public booking configuration: getR1MeetGoogleOAuthClientInputs', () => {
  const inputs = (source: Record<string, unknown>): R1MeetGoogleOAuthClientInputs =>
    getR1MeetGoogleOAuthClientInputs(source as R1MeetEnvSource);

  it('returns the values, the secret readable by name only', () => {
    const result = inputs({
      R1_MEET_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID_VALUE,
      R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: CS_VALUE,
      R1_MEET_GOOGLE_DEX_EMAIL: 'Dex@Hello.Example.Test',
      R1_MEET_GOOGLE_MEET_MODE: 'space',
    });
    expect(result).toStrictEqual({ clientId: CLIENT_ID_VALUE, dexEmail: DEX_EMAIL, meetMode: 'space' });
    expect(Object.keys(result)).toEqual(['clientId', 'dexEmail', 'meetMode']);
    expect(result.clientSecret).toBe(CS_VALUE);
    expect(JSON.stringify(result)).not.toContain(CS_VALUE);
    expect(JSON.stringify({ ...result })).not.toContain(CS_VALUE);
    expect(Object.isFrozen(result)).toBe(true);
    expect(logged).toEqual([]);
  });

  it('is null for unset, placeholder or malformed values; a blank Meet mode is calendar', () => {
    const empty = inputs({});
    expect(empty).toStrictEqual({ clientId: null, dexEmail: null, meetMode: 'calendar' });
    expect(empty.clientSecret).toBeNull();
    const bad = inputs({
      R1_MEET_GOOGLE_OAUTH_CLIENT_ID: 'nope',
      R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'replace_me',
      R1_MEET_GOOGLE_DEX_EMAIL: 'nope',
      R1_MEET_GOOGLE_MEET_MODE: 'zoom',
    });
    expect(bad).toStrictEqual({ clientId: null, dexEmail: null, meetMode: null });
    expect(bad.clientSecret).toBeNull();
    expect(inputs({ R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: 'a b' }).clientSecret).toBeNull();
    expect(inputs({ R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: '' }).clientSecret).toBeNull();
    expect(inputs({ R1_MEET_GOOGLE_MEET_MODE: 'calendar' }).meetMode).toBe('calendar');
  });

  it('reads exactly its four variables', () => {
    const reads: string[] = [];
    const source = new Proxy(saValid({ R1_MEET_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID_VALUE, R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: CS_VALUE }), {
      get(target, name) {
        reads.push(String(name));
        return target[name as keyof R1MeetEnvSource];
      },
    });
    expect(getR1MeetGoogleOAuthClientInputs(source).clientId).toBe(CLIENT_ID_VALUE);
    expect([...new Set(reads)].sort()).toEqual(
      [
        'R1_MEET_GOOGLE_OAUTH_CLIENT_ID',
        'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET',
        'R1_MEET_GOOGLE_DEX_EMAIL',
        'R1_MEET_GOOGLE_MEET_MODE',
      ].sort(),
    );
  });

  it('reads process.env when no source is passed', () => {
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID_VALUE);
    vi.stubEnv('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', CS_VALUE);
    vi.stubEnv('R1_MEET_GOOGLE_DEX_EMAIL', DEX_EMAIL);
    vi.stubEnv('R1_MEET_GOOGLE_MEET_MODE', '');
    const result = getR1MeetGoogleOAuthClientInputs();
    expect(result).toStrictEqual({ clientId: CLIENT_ID_VALUE, dexEmail: DEX_EMAIL, meetMode: 'calendar' });
    expect(result.clientSecret).toBe(CS_VALUE);
  });

  it('never throws: a throwing source gives all nulls, silently', () => {
    const throwing = new Proxy({} as R1MeetEnvSource, {
      get() {
        throw new Error('boom');
      },
    });
    let result: R1MeetGoogleOAuthClientInputs | undefined;
    expect(() => {
      result = getR1MeetGoogleOAuthClientInputs(throwing);
    }).not.toThrow();
    expect(result).toStrictEqual({ clientId: null, dexEmail: null, meetMode: null });
    expect(result!.clientSecret).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(logged).toEqual([]);
  });
});
