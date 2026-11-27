/**
 * R1-over-Google-Meet configuration (M034, dark by default).
 *
 * Booking source (D-M034-11): HR schedules the interview IN ASHBY with the Ashby user
 * "Dex (AI Interviewer)" as an interviewer; Ashby creates the Google Meet and invites the candidate
 * and the bot's Google account; the Ashby `interviewScheduleCreate` / `interviewScheduleUpdate`
 * webhooks are the source of truth. `R1_MEET_ASHBY_DEX_USER_ID` names that Ashby user, so only the
 * events Dex is on get a bot. There is no third-party booking page, no Google Calendar sync and no
 * Recall Calendar V2. The Ashby webhook itself reuses the existing Ashby receiver's secret: no Meet
 * variable for it.
 *
 * Like `../config.ts` and `../recording/config.ts`, this is deliberately NOT part of env.ts: env.ts
 * throws at import on a malformed value, which would crash-loop the API that also runs phone
 * dialing. This module is lazy and NEVER throws; a bad value turns Meet OFF (status `invalid`) and
 * logs one line that names the variable but never its value (two of them are credentials).
 *
 *   R1_MEET_ENABLED unset, blank or exactly "false"           -> `disabled` (nothing else is inspected)
 *   R1_MEET_ENABLED any other value than exactly "true"       -> `invalid`  (Meet off)
 *   "true" but a knob, WEB_ORIGIN or a required value is bad   -> `invalid`  (Meet off)
 *   "true" and everything present and well formed              -> `enabled`
 *
 * Check order when the flag is "true" (the first failure is the reason): the knobs
 * (R1_MEET_DAILY_BOT_CAP, R1_MEET_BOT_NAME, R1_MEET_GOOGLE_LOGIN_GROUP_ID, R1_MEET_SERVICE_USER_ID,
 * RECALL_BASE_URL, R1_MEET_ARM_AT_CREATE, R1_MEET_MULTI_HUMAN_POLICY), then the first WEB_ORIGIN
 * entry, then the three required values present (in `R1_MEET_REQUIRED_VARIABLES` order), then each
 * of them well formed in the same order.
 *
 * The two runtime switches (M034 S06) exist because only a live call can settle them, and each must
 * be reversible without a deploy:
 *   R1_MEET_ARM_AT_CREATE       blank or "false" = the bridge page is opened when a human joins;
 *                               "true" = it is armed when the bot is created (critic B2).
 *   R1_MEET_MULTI_HUMAN_POLICY  blank or "observe" = a second human in the call is only logged;
 *                               "end" = it ends the call (critic C4). The default stays `observe`
 *                               until the live spike shows whether Recall reports the bot's own join
 *                               and whether HR must stay to admit the candidate (PR #444 review
 *                               S06-R3): with either, `end` would cut every interview at 2 minutes.
 *
 * The drain (M034 S06) must be able to remove bots AFTER the flag was turned off, so it cannot use
 * the enabled configuration: `getR1MeetDrainConfig` reads the Recall key and base URL and nothing
 * else, and `r1MeetDrainAllowed` says yes only for `disabled`. A typo (`invalid`) never drains: it
 * would cancel every booked interview.
 *
 * `R1_MEET_SERVICE_USER_ID` is optional. Blank = no fallback: a booking whose Ashby scheduler is not
 * one of our staff users gets no round and no bot. Set = that staff user owns such rounds
 * (`interview_rounds.created_by`). The consent attestation always names the Ashby scheduler, never
 * this user.
 *
 * Meet is active only when `getR1Config().enabled` AND this module says `enabled`: see
 * `r1MeetActive`.
 *
 * `R1_MEET_ASHBY_FEEDBACK_FORM_ID` (M034 S09) is the UUID of the Ashby feedback form assigned to the
 * Dex interview: Dex's scorecard is posted there as that interview's feedback. It has its own silent
 * reader, `getR1MeetFeedbackConfig` (blank = `off`, a UUID = `on`, anything else = `invalid`), and
 * `getR1MeetConfig` IGNORES it: a missing or malformed form id never turns Meet off, so bots keep
 * joining while the feedback form is fixed.
 *
 * M035 (one public booking link, dark): `getR1MeetPublicConfig` is a SEPARATE, silent reader for the
 * public `/book` page where any candidate already in Ashby books Dex over Google Meet. Its flag,
 * R1_MEET_PUBLIC_BOOKING_ENABLED, sits ON TOP OF R1_MEET_ENABLED and R1_ENABLED. It never changes
 * what `getR1MeetConfig` answers, and `getR1MeetConfig` reads none of its variables: a bad public
 * knob never stops the bots of existing bookings. It logs nothing of its own; the fixed reason rides
 * on the object for the caller's `r1_meet_public_setup_error` alert. Dex is a normal, non-admin user
 * of the company Google Workspace, so the DEFAULT auth mode is `oauth_refresh`: an OAuth client and
 * a refresh token the owner mints once, signed in as Dex (scripts/m035-google-oauth-consent.ts).
 * Domain-wide delegation could impersonate any employee of that Workspace, so `service_account` is
 * only for a dedicated Dex Workspace. The three Google credentials (`R1_MEET_PUBLIC_SECRET_VARIABLES`)
 * are not Meet requirements: Meet keeps working without them. The default bot is the GUEST bot:
 * R1_MEET_GOOGLE_LOGIN_GROUP_ID is NOT required (unset = `botMode: 'guest'`), so every Dex meeting
 * must be OPEN. `getR1MeetPublicDrainConfig` is the Google half of the drain (read whatever the
 * flags say) and `getR1MeetGoogleOAuthClientInputs` feeds the consent helper.
 *
 * This is the ONLY module that reads the Meet variables. The vendor modules (integrations/recall,
 * integrations/google-meet, integrations/google) read no environment at all and take the values
 * below as explicit arguments; `r1-room-isolation.test.ts` pins both rules. The credentials are Fly
 * secrets on the API (`project-hello-api`) only: never in fly.toml, never on the workers. Each
 * variable is read as a literal property of process.env (never a computed key) so
 * `scripts/check-env-contract.mjs` sees it.
 *
 * Derived URLs (no variables of their own): the candidate bridge page the bot shows as its camera
 * and the Recall real-time webhook are both built on the first WEB_ORIGIN entry, the same rule as
 * the R1 join link (`routes/r1.ts`). The web app must serve `R1_MEET_BRIDGE_PAGE_PATH` and the API
 * must mount the receiver at `R1_MEET_RECALL_REALTIME_PATH` (reached through the web host's
 * `/api/*` rewrite).
 */

import {
  RECALL_DEFAULT_BASE_URL,
  decodeRecallWebhookSecret,
  isRecallApiKeyShaped,
  normalizeRecallBaseUrl,
} from '../../../integrations/recall/settings.js';

/** The web page the Meet bot shows as its camera (served by the web app). */
export const R1_MEET_BRIDGE_PAGE_PATH = '/candidate/r1/meet';
/** Where Recall posts real-time participant events (the API receiver mounts exactly this path). */
export const R1_MEET_RECALL_REALTIME_PATH = '/api/integrations/recall/realtime';

/** Bots created per IST day at most. A cost cap: out of range is `invalid`, never clamped. */
export const R1_MEET_DAILY_BOT_CAP_DEFAULT = 20;
export const R1_MEET_DAILY_BOT_CAP_MIN = 1;
export const R1_MEET_DAILY_BOT_CAP_MAX = 200;
export const R1_MEET_BOT_NAME_MAX_LENGTH = 100;

/** What a second human in the Meet does: end the call, or only be logged. Frozen. */
export const R1_MEET_MULTI_HUMAN_POLICIES = Object.freeze(['end', 'observe'] as const);
export type R1MeetMultiHumanPolicy = (typeof R1_MEET_MULTI_HUMAN_POLICIES)[number];
export const R1_MEET_MULTI_HUMAN_POLICY_DEFAULT: R1MeetMultiHumanPolicy = 'observe';

/** The Ashby user id of "Dex (AI Interviewer)": required, but not a credential. */
const R1_MEET_DEX_USER_VARIABLE = 'R1_MEET_ASHBY_DEX_USER_ID';

/**
 * M035: the public booking link's variables, in the contract §2 table order: the flag, Dex's Google
 * account (auth mode, OAuth client id and secret, refresh token, service-account key, Dex's email,
 * Meet mode), then the slot and booking knobs. Read only by the public readers at the end of this
 * module, never by `getR1MeetConfig`.
 */
export const R1_MEET_PUBLIC_ENV_VARIABLES = [
  'R1_MEET_PUBLIC_BOOKING_ENABLED',
  'R1_MEET_GOOGLE_AUTH_MODE', // oauth_refresh (default) or service_account
  'R1_MEET_GOOGLE_OAUTH_CLIENT_ID', // oauth_refresh mode
  'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', // oauth_refresh mode, a Fly secret
  'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', // oauth_refresh mode, a Fly secret
  'R1_MEET_GOOGLE_SA_KEY_B64', // service_account mode, a Fly secret
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
] as const;
export type R1MeetPublicEnvName = (typeof R1_MEET_PUBLIC_ENV_VARIABLES)[number];

/**
 * Every variable this module owns (WEB_ORIGIN is shared and declared elsewhere): the flag, the
 * knobs, the Dex user id and the feedback form id first, then the two Recall credentials (the
 * twelve M034 variables), then the twenty-three M035 public booking variables.
 */
export const R1_MEET_ENV_VARIABLES = [
  'R1_MEET_ENABLED',
  'R1_MEET_BOT_NAME',
  'R1_MEET_DAILY_BOT_CAP',
  'R1_MEET_GOOGLE_LOGIN_GROUP_ID',
  'R1_MEET_SERVICE_USER_ID',
  'RECALL_BASE_URL',
  'R1_MEET_ARM_AT_CREATE',
  'R1_MEET_MULTI_HUMAN_POLICY',
  R1_MEET_DEX_USER_VARIABLE,
  'R1_MEET_ASHBY_FEEDBACK_FORM_ID',
  'RECALL_API_KEY',
  'RECALL_WEBHOOK_SECRET',
  ...R1_MEET_PUBLIC_ENV_VARIABLES,
] as const;
export type R1MeetEnvName = (typeof R1_MEET_ENV_VARIABLES)[number];
export type R1MeetEnvSource = Partial<Record<R1MeetEnvName | 'WEB_ORIGIN', string | undefined>>;

/** The two credentials: Fly secrets only, and `replace_me` in `.env.example`. */
export const R1_MEET_SECRET_VARIABLES = [
  'RECALL_API_KEY',
  'RECALL_WEBHOOK_SECRET',
] as const satisfies readonly R1MeetEnvName[];

/** Required when the flag is "true", checked in this order: the two credentials, then the Dex user id. */
export const R1_MEET_REQUIRED_VARIABLES = [
  ...R1_MEET_SECRET_VARIABLES,
  R1_MEET_DEX_USER_VARIABLE,
] as const satisfies readonly R1MeetEnvName[];

/**
 * M035: the three Google credentials of Dex's account. Fly secrets only and `replace_me` in
 * `.env.example`, like the Recall pair, but NOT in `R1_MEET_SECRET_VARIABLES` or
 * `R1_MEET_REQUIRED_VARIABLES`: Meet keeps working without Google. Only the chosen auth mode's
 * credentials are required, and only when the public flag is "true".
 */
export const R1_MEET_PUBLIC_SECRET_VARIABLES = [
  'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', // oauth_refresh mode, a Fly secret
  'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN', // oauth_refresh mode, a Fly secret
  'R1_MEET_GOOGLE_SA_KEY_B64', // service_account mode, a Fly secret
] as const satisfies readonly R1MeetPublicEnvName[];

/**
 * Ids `R1_MEET_SERVICE_USER_ID` may never name: the nil UUID and the Ashby integration's system
 * actor (`integrations/ashby/workflow-stores.ts`), which has no `auth.users` row, so a round it
 * "created" could not own a call session.
 */
const R1_MEET_REFUSED_SERVICE_USER_IDS: ReadonlySet<string> = new Set([
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000001',
]);

export type R1MeetConfigStatus = 'enabled' | 'disabled' | 'invalid';

/**
 * What the Recall client and webhook verifier need. The credentials are NON-ENUMERABLE so
 * spreading, `JSON.stringify` or a stray log of the config cannot leak them; read them by property
 * name. `webhookSecret` is the raw `whsec_`-prefixed text (already checked to decode).
 */
export interface R1MeetRecallSettings {
  readonly baseUrl: string;
  readonly googleLoginGroupId: string | null;
  readonly apiKey: string;
  readonly webhookSecret: string;
}

/** Which Ashby interview events are Dex's (D-M034-11). Not a credential. */
export interface R1MeetAshbySettings {
  /** The Ashby user id of "Dex (AI Interviewer)", lower-cased. */
  readonly dexUserId: string;
}

export type R1MeetConfig =
  | { readonly enabled: false; readonly status: 'disabled' }
  | { readonly enabled: false; readonly status: 'invalid'; readonly reason: string }
  | {
      readonly enabled: true;
      readonly status: 'enabled';
      readonly recall: R1MeetRecallSettings;
      readonly ashby: R1MeetAshbySettings;
      /**
       * Our staff user (auth user id, lower-cased) that owns a round when the Ashby scheduler maps
       * to none of our users; null = no fallback (that booking gets no round and no bot).
       */
      readonly serviceUserId: string | null;
      /** Overrides the objective profile's bot display name; null = use the profile's. */
      readonly botNameOverride: string | null;
      readonly dailyBotCap: number;
      /** Arm the bridge page when the bot is created, instead of when a human joins. */
      readonly armAtCreate: boolean;
      readonly multiHumanPolicy: R1MeetMultiHumanPolicy;
      readonly bridgePageUrl: string;
      readonly recallRealtimeWebhookUrl: string;
    };

/** What the drain needs to remove bots while Meet is off. `apiKey` is NON-ENUMERABLE, as above. */
export interface R1MeetDrainRecallSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export type R1MeetDrainConfig =
  | { readonly available: false }
  | { readonly available: true; readonly recall: R1MeetDrainRecallSettings };

/**
 * Where Dex's scorecard is posted in Ashby (M034 S09). `off` = not posted (inert); `on` = the form id,
 * verbatim (Ashby ids are matched exactly); `invalid` = not posted, with a fixed reason that names
 * the variable but never its value. Independent of `R1MeetConfig`: it never turns Meet off.
 */
export type R1MeetFeedbackConfig =
  | { readonly status: 'off' }
  | { readonly status: 'on'; readonly formDefinitionId: string }
  | { readonly status: 'invalid'; readonly reason: string };

// Every reason is one of a small set of fixed strings, so remembering them all is bounded and means
// each problem is logged once per process however often the config is re-read.
const reported = new Set<string>();
function report(reason: string): void {
  if (reported.has(reason)) return;
  reported.add(reason);
  // The reason names a variable, never a value: two of them are credentials.
  console.error(`[r1-meet-config] Meet off: ${reason}`);
}
/** Test seam: forget what was reported so a test can observe the lines again. */
export function resetR1MeetConfigReport(): void {
  reported.clear();
}

const DIGITS = /^[0-9]{1,12}$/;
// Lower- or upper-case UUID; normalised to lower case (Recall prints ids in lower case).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control, format (zero-width, bidi overrides), surrogate, private-use and line/paragraph separators:
// none of them belongs in a name shown to a candidate.
const NAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const SURROUNDING_SPACE = /^\s|\s$/u;

/** Set means "not undefined and not blank". A non-string value counts as set (and is then invalid). */
function present(value: unknown): boolean {
  return value !== undefined && value !== '';
}

// `.env.example` carries this placeholder in the two credential slots (the env-contract check
// demands it). A developer who copies the file must not get a "malformed" report for a
// placeholder, so the exact placeholder counts as unset for those two variables only.
const CREDENTIAL_PLACEHOLDER = 'replace_me';
const SECRET_NAMES: ReadonlySet<string> = new Set(R1_MEET_SECRET_VARIABLES);
function isSet(name: (typeof R1_MEET_REQUIRED_VARIABLES)[number], value: unknown): boolean {
  if (SECRET_NAMES.has(name) && value === CREDENTIAL_PLACEHOLDER) return false;
  return present(value);
}

function parseCap(raw: unknown): number | null {
  if (!present(raw)) return R1_MEET_DAILY_BOT_CAP_DEFAULT;
  if (typeof raw !== 'string' || !DIGITS.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= R1_MEET_DAILY_BOT_CAP_MIN && value <= R1_MEET_DAILY_BOT_CAP_MAX
    ? value
    : null;
}

/** `undefined` = invalid; `null` = unset (use the profile's name). */
function parseBotName(raw: unknown): string | null | undefined {
  if (!present(raw)) return null;
  if (typeof raw !== 'string') return undefined;
  if (raw.length > R1_MEET_BOT_NAME_MAX_LENGTH) return undefined;
  if (NAME_FORBIDDEN.test(raw) || SURROUNDING_SPACE.test(raw)) return undefined;
  return raw;
}

/** `undefined` = invalid; `null` = unset (the bot joins signed out). */
function parseLoginGroupId(raw: unknown): string | null | undefined {
  if (!present(raw)) return null;
  if (typeof raw !== 'string' || !UUID.test(raw)) return undefined;
  return raw.toLowerCase();
}

/** `undefined` = invalid; `null` = unset (no fallback owner). */
function parseServiceUserId(raw: unknown): string | null | undefined {
  if (!present(raw)) return null;
  if (typeof raw !== 'string' || !UUID.test(raw)) return undefined;
  const id = raw.toLowerCase();
  return R1_MEET_REFUSED_SERVICE_USER_IDS.has(id) ? undefined : id;
}

/** `undefined` = invalid. Blank is false: the same strict spelling as the flag itself. */
function parseArmAtCreate(raw: unknown): boolean | undefined {
  if (!present(raw) || raw === 'false') return false;
  return raw === 'true' ? true : undefined;
}

/** `undefined` = invalid. */
function parseMultiHumanPolicy(raw: unknown): R1MeetMultiHumanPolicy | undefined {
  if (!present(raw)) return R1_MEET_MULTI_HUMAN_POLICY_DEFAULT;
  return R1_MEET_MULTI_HUMAN_POLICIES.find((policy) => policy === raw);
}

/** The Recall origin: blank = the default region; null = malformed. */
function parseBaseUrl(raw: unknown): string | null {
  return present(raw) ? normalizeRecallBaseUrl(raw) : RECALL_DEFAULT_BASE_URL;
}

/**
 * The first WEB_ORIGIN entry as a canonical https origin, or null. Same selection as the R1 join
 * link (`routes/r1.ts`): split on ',', take the first entry, drop trailing '/'. The entry must then
 * be a bare https origin: no userinfo, path, query or fragment.
 */
function firstHttpsWebOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const first = (raw.split(',')[0] ?? '').trim().replace(/\/+$/, '');
  if (first === '') return null;
  let url: URL;
  try {
    url = new URL(first);
  } catch {
    return null;
  }
  const ok =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    // Exactly the origin, case aside: rejects a bare '?' or '#', ':443', 'https:host' and other
    // spellings the URL parser would silently repair.
    first.toLowerCase() === url.origin;
  return ok ? url.origin : null;
}

function withHiddenCredentials<T extends object>(visible: T, hidden: Readonly<Record<string, string | null>>): T {
  const settings = { ...visible };
  for (const [name, value] of Object.entries(hidden)) {
    Object.defineProperty(settings, name, { value, enumerable: false });
  }
  return Object.freeze(settings);
}

function invalid(reason: string): R1MeetConfig {
  report(reason);
  return { enabled: false, status: 'invalid', reason };
}

const MISSING_REASON: Readonly<Record<(typeof R1_MEET_REQUIRED_VARIABLES)[number], string>> = {
  RECALL_API_KEY: 'RECALL_API_KEY is required when R1_MEET_ENABLED is "true"',
  RECALL_WEBHOOK_SECRET: 'RECALL_WEBHOOK_SECRET is required when R1_MEET_ENABLED is "true"',
  R1_MEET_ASHBY_DEX_USER_ID: 'R1_MEET_ASHBY_DEX_USER_ID is required when R1_MEET_ENABLED is "true"',
};

/** The twelve M034 Meet variables and WEB_ORIGIN: what `getR1MeetConfig` reads. No M035 name. */
function readProcessEnv(): R1MeetEnvSource {
  return {
    R1_MEET_ENABLED: process.env.R1_MEET_ENABLED,
    R1_MEET_BOT_NAME: process.env.R1_MEET_BOT_NAME,
    R1_MEET_DAILY_BOT_CAP: process.env.R1_MEET_DAILY_BOT_CAP,
    R1_MEET_GOOGLE_LOGIN_GROUP_ID: process.env.R1_MEET_GOOGLE_LOGIN_GROUP_ID,
    R1_MEET_SERVICE_USER_ID: process.env.R1_MEET_SERVICE_USER_ID,
    RECALL_BASE_URL: process.env.RECALL_BASE_URL,
    R1_MEET_ARM_AT_CREATE: process.env.R1_MEET_ARM_AT_CREATE,
    R1_MEET_MULTI_HUMAN_POLICY: process.env.R1_MEET_MULTI_HUMAN_POLICY,
    R1_MEET_ASHBY_DEX_USER_ID: process.env.R1_MEET_ASHBY_DEX_USER_ID,
    R1_MEET_ASHBY_FEEDBACK_FORM_ID: process.env.R1_MEET_ASHBY_FEEDBACK_FORM_ID,
    RECALL_API_KEY: process.env.RECALL_API_KEY,
    RECALL_WEBHOOK_SECRET: process.env.RECALL_WEBHOOK_SECRET,
    WEB_ORIGIN: process.env.WEB_ORIGIN,
  };
}

/**
 * Every Meet variable (the twelve M034 ones, the twenty-three M035 public booking ones) and
 * WEB_ORIGIN. Used ONLY by `getR1MeetPublicConfig`, so the Google secrets are copied into a plain
 * object only on the public path, never on the M034 Meet readers' hot path.
 */
function readPublicProcessEnv(): R1MeetEnvSource {
  return {
    ...readProcessEnv(),
    R1_MEET_PUBLIC_BOOKING_ENABLED: process.env.R1_MEET_PUBLIC_BOOKING_ENABLED,
    R1_MEET_GOOGLE_AUTH_MODE: process.env.R1_MEET_GOOGLE_AUTH_MODE,
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: process.env.R1_MEET_GOOGLE_OAUTH_CLIENT_ID,
    R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: process.env.R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET,
    R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: process.env.R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN,
    R1_MEET_GOOGLE_SA_KEY_B64: process.env.R1_MEET_GOOGLE_SA_KEY_B64,
    R1_MEET_GOOGLE_DEX_EMAIL: process.env.R1_MEET_GOOGLE_DEX_EMAIL,
    R1_MEET_GOOGLE_MEET_MODE: process.env.R1_MEET_GOOGLE_MEET_MODE,
    R1_MEET_PUBLIC_SLOT_MINUTES: process.env.R1_MEET_PUBLIC_SLOT_MINUTES,
    R1_MEET_PUBLIC_SLOT_STEP_MINUTES: process.env.R1_MEET_PUBLIC_SLOT_STEP_MINUTES,
    R1_MEET_PUBLIC_HOURS_IST: process.env.R1_MEET_PUBLIC_HOURS_IST,
    R1_MEET_PUBLIC_DAYS: process.env.R1_MEET_PUBLIC_DAYS,
    R1_MEET_PUBLIC_CLOSED_DATES: process.env.R1_MEET_PUBLIC_CLOSED_DATES,
    R1_MEET_PUBLIC_MIN_NOTICE_MINUTES: process.env.R1_MEET_PUBLIC_MIN_NOTICE_MINUTES,
    R1_MEET_PUBLIC_HORIZON_DAYS: process.env.R1_MEET_PUBLIC_HORIZON_DAYS,
    R1_MEET_PUBLIC_SLOT_CAPACITY: process.env.R1_MEET_PUBLIC_SLOT_CAPACITY,
    R1_MEET_PUBLIC_BROWSER_HEADROOM: process.env.R1_MEET_PUBLIC_BROWSER_HEADROOM,
    R1_MEET_PUBLIC_DAILY_CAP: process.env.R1_MEET_PUBLIC_DAILY_CAP,
    R1_MEET_PUBLIC_MAX_MOVES: process.env.R1_MEET_PUBLIC_MAX_MOVES,
    R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES: process.env.R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES,
    R1_MEET_PUBLIC_REQUIRE_R1_STAGE: process.env.R1_MEET_PUBLIC_REQUIRE_R1_STAGE,
    R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS: process.env.R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS,
    R1_MEET_PUBLIC_PRESLOT_RECHECK: process.env.R1_MEET_PUBLIC_PRESLOT_RECHECK,
  };
}

/**
 * Inspect the environment. NEVER throws. `source` is a test seam; production passes nothing and the
 * variables are read as literal property accesses on process.env.
 */
export function getR1MeetConfig(source?: R1MeetEnvSource): R1MeetConfig {
  try {
    const env: R1MeetEnvSource = source ?? readProcessEnv();

    // Same strict rule as R1_ENABLED: only the exact text "true" turns it on.
    const flag: unknown = env.R1_MEET_ENABLED;
    if (flag === undefined || flag === '' || flag === 'false') return { enabled: false, status: 'disabled' };
    if (flag !== 'true') return invalid('R1_MEET_ENABLED must be either "true" or "false"');

    const dailyBotCap = parseCap(env.R1_MEET_DAILY_BOT_CAP);
    if (dailyBotCap === null) {
      return invalid(
        `R1_MEET_DAILY_BOT_CAP must be an integer from ${R1_MEET_DAILY_BOT_CAP_MIN} to ${R1_MEET_DAILY_BOT_CAP_MAX}`,
      );
    }
    const botNameOverride = parseBotName(env.R1_MEET_BOT_NAME);
    if (botNameOverride === undefined) {
      return invalid(
        `R1_MEET_BOT_NAME must be 1 to ${R1_MEET_BOT_NAME_MAX_LENGTH} characters with no control characters and no surrounding spaces`,
      );
    }
    const googleLoginGroupId = parseLoginGroupId(env.R1_MEET_GOOGLE_LOGIN_GROUP_ID);
    if (googleLoginGroupId === undefined) return invalid('R1_MEET_GOOGLE_LOGIN_GROUP_ID must be a UUID');
    const serviceUserId = parseServiceUserId(env.R1_MEET_SERVICE_USER_ID);
    if (serviceUserId === undefined) {
      return invalid('R1_MEET_SERVICE_USER_ID must be the UUID of a real staff user (not the nil or system-actor id)');
    }
    const baseUrl = parseBaseUrl(env.RECALL_BASE_URL);
    if (baseUrl === null) {
      return invalid('RECALL_BASE_URL must be an https origin on a <region>.recall.ai host, with no path, port or query');
    }
    const armAtCreate = parseArmAtCreate(env.R1_MEET_ARM_AT_CREATE);
    if (armAtCreate === undefined) return invalid('R1_MEET_ARM_AT_CREATE must be either "true" or "false"');
    const multiHumanPolicy = parseMultiHumanPolicy(env.R1_MEET_MULTI_HUMAN_POLICY);
    if (multiHumanPolicy === undefined) return invalid('R1_MEET_MULTI_HUMAN_POLICY must be "end" or "observe"');

    const origin = firstHttpsWebOrigin(env.WEB_ORIGIN);
    if (origin === null) {
      return invalid('WEB_ORIGIN must start with an https origin (no path, query or credentials) when R1_MEET_ENABLED is "true"');
    }

    for (const name of R1_MEET_REQUIRED_VARIABLES) {
      if (!isSet(name, env[name])) return invalid(MISSING_REASON[name]);
    }

    const apiKey: unknown = env.RECALL_API_KEY;
    if (!isRecallApiKeyShaped(apiKey)) return invalid('RECALL_API_KEY is malformed');
    const webhookSecret: unknown = env.RECALL_WEBHOOK_SECRET;
    if (typeof webhookSecret !== 'string' || decodeRecallWebhookSecret(webhookSecret) === null) {
      return invalid('RECALL_WEBHOOK_SECRET is malformed (expected the whsec_-prefixed workspace verification secret)');
    }
    const dexUserId: unknown = env.R1_MEET_ASHBY_DEX_USER_ID;
    if (typeof dexUserId !== 'string' || !UUID.test(dexUserId)) {
      return invalid('R1_MEET_ASHBY_DEX_USER_ID must be a UUID (the Ashby user id of "Dex (AI Interviewer)")');
    }

    return Object.freeze({
      enabled: true as const,
      status: 'enabled' as const,
      recall: withHiddenCredentials({ baseUrl, googleLoginGroupId }, { apiKey, webhookSecret }) as R1MeetRecallSettings,
      ashby: Object.freeze({ dexUserId: dexUserId.toLowerCase() }),
      serviceUserId,
      botNameOverride,
      dailyBotCap,
      armAtCreate,
      multiHumanPolicy,
      bridgePageUrl: `${origin}${R1_MEET_BRIDGE_PAGE_PATH}`,
      recallRealtimeWebhookUrl: `${origin}${R1_MEET_RECALL_REALTIME_PATH}`,
    });
  } catch {
    // Defensive (e.g. a throwing getter on the source): this module's contract is that it never throws.
    return invalid('unexpected error while reading the Meet configuration');
  }
}

/** Meet work may run only when R1 itself is on AND the Meet configuration is enabled. */
export function r1MeetActive(r1: { readonly enabled: boolean }, meet: R1MeetConfig): boolean {
  return r1.enabled === true && meet.enabled === true;
}

const FEEDBACK_OFF: R1MeetFeedbackConfig = Object.freeze({ status: 'off' as const });
const FEEDBACK_FORM_REASON =
  'R1_MEET_ASHBY_FEEDBACK_FORM_ID must be a UUID (the feedback form of the Dex interview in Ashby)';
/** The nil UUID names no Ashby form: refused, like `R1_MEET_REFUSED_SERVICE_USER_IDS`. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The Ashby feedback form Dex's scorecard is posted to (M034 S09). Reads R1_MEET_ASHBY_FEEDBACK_FORM_ID
 * and nothing else. Silent (no log line: the S09 handler alerts per affected interview) and NEVER
 * throws. Unset or blank = `off`; a UUID other than the nil one = `on`, lower-cased (Ashby's ids are
 * lower case, and an id pasted in upper case names the same form); anything else, including
 * surrounding spaces, = `invalid`. `source` is a test seam, as for `getR1MeetConfig`.
 */
export function getR1MeetFeedbackConfig(
  source?: Pick<R1MeetEnvSource, 'R1_MEET_ASHBY_FEEDBACK_FORM_ID'>,
): R1MeetFeedbackConfig {
  try {
    const env = source ?? { R1_MEET_ASHBY_FEEDBACK_FORM_ID: process.env.R1_MEET_ASHBY_FEEDBACK_FORM_ID };
    const formDefinitionId: unknown = env.R1_MEET_ASHBY_FEEDBACK_FORM_ID;
    if (!present(formDefinitionId)) return FEEDBACK_OFF;
    if (typeof formDefinitionId !== 'string' || !UUID.test(formDefinitionId) || formDefinitionId === NIL_UUID) {
      return Object.freeze({ status: 'invalid' as const, reason: FEEDBACK_FORM_REASON });
    }
    return Object.freeze({ status: 'on' as const, formDefinitionId: formDefinitionId.toLowerCase() });
  } catch {
    // Defensive (e.g. a throwing getter on the source): this reader never throws either.
    return Object.freeze({
      status: 'invalid' as const,
      reason: 'unexpected error while reading the Meet feedback configuration',
    });
  }
}

const DRAIN_UNAVAILABLE: R1MeetDrainConfig = Object.freeze({ available: false as const });

/**
 * What the drain needs to remove bots from Recall, whatever the flag says (M034 S06). Reads only
 * RECALL_API_KEY and RECALL_BASE_URL. Silent and NEVER throws: an absent, placeholder or malformed
 * key (or base URL) simply means there is nothing this process could drain with. It grants nothing
 * by itself: see `r1MeetDrainAllowed`.
 */
export function getR1MeetDrainConfig(
  source?: Pick<R1MeetEnvSource, 'RECALL_API_KEY' | 'RECALL_BASE_URL'>,
): R1MeetDrainConfig {
  try {
    const env = source ?? {
      RECALL_API_KEY: process.env.RECALL_API_KEY,
      RECALL_BASE_URL: process.env.RECALL_BASE_URL,
    };
    const apiKey: unknown = env.RECALL_API_KEY;
    if (!isSet('RECALL_API_KEY', apiKey) || !isRecallApiKeyShaped(apiKey)) return DRAIN_UNAVAILABLE;
    const baseUrl = parseBaseUrl(env.RECALL_BASE_URL);
    if (baseUrl === null) return DRAIN_UNAVAILABLE;
    return Object.freeze({
      available: true as const,
      recall: withHiddenCredentials({ baseUrl }, { apiKey }) as R1MeetDrainRecallSettings,
    });
  } catch {
    return DRAIN_UNAVAILABLE;
  }
}

/**
 * The flag-off backstop may drain only when Meet was deliberately turned OFF. `invalid` is a typo or
 * a lost secret, and a drained booking is terminal, so it must never cancel every booked interview.
 */
export function r1MeetDrainAllowed(meet: R1MeetConfig): boolean {
  return meet.status === 'disabled';
}

/** Health/metadata view: status and reason only, never a credential, URL or knob value. */
export function describeR1MeetConfig(
  meet: R1MeetConfig,
): { readonly enabled: boolean; readonly status: R1MeetConfigStatus; readonly reason?: string } {
  if (meet.status === 'invalid') return { enabled: false, status: 'invalid', reason: meet.reason };
  return { enabled: meet.enabled, status: meet.status };
}

// ── M035: the public booking link (dark) ──────────────────────────────────────────────────────────

/** The public booking page and its manage page, served by the web app on the first WEB_ORIGIN entry. */
export const R1_MEET_PUBLIC_BOOK_PAGE_PATH = '/book';
export const R1_MEET_PUBLIC_MANAGE_PAGE_PATH = '/book/manage';

/**
 * How the API acts as Dex. DEFAULT `oauth_refresh`: Dex is a normal user of the company Workspace and
 * the API holds that user's own OAuth grant. `service_account` (domain-wide delegation) only for a
 * dedicated Dex Workspace: in the company Workspace it could impersonate any employee.
 */
export const R1_MEET_GOOGLE_AUTH_MODES = Object.freeze(['oauth_refresh', 'service_account'] as const);
export type R1MeetGoogleAuthMode = (typeof R1_MEET_GOOGLE_AUTH_MODES)[number];
export const R1_MEET_GOOGLE_AUTH_MODE_DEFAULT: R1MeetGoogleAuthMode = 'oauth_refresh';

/** Where the Meet comes from: the calendar event's own conference (DEFAULT), or a Meet space first. */
export const R1_MEET_GOOGLE_MEET_MODES = Object.freeze(['calendar', 'space'] as const);
export type R1MeetGoogleMeetMode = (typeof R1_MEET_GOOGLE_MEET_MODES)[number];
export const R1_MEET_GOOGLE_MEET_MODE_DEFAULT: R1MeetGoogleMeetMode = 'calendar';

export interface R1MeetPublicIntegerKnob {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}
const integerKnob = (fallback: number, min: number, max: number): R1MeetPublicIntegerKnob =>
  Object.freeze({ default: fallback, min, max });

/**
 * The integer knobs (contract §2), in table order. Blank = default; anything else must be
 * `^[0-9]{1,12}$` and inside the range: out of range is `invalid`, never clamped.
 */
export const R1_MEET_PUBLIC_INTEGER_KNOBS = Object.freeze({
  R1_MEET_PUBLIC_SLOT_MINUTES: integerKnob(45, 30, 60),
  R1_MEET_PUBLIC_MIN_NOTICE_MINUTES: integerKnob(60, 30, 1440),
  R1_MEET_PUBLIC_HORIZON_DAYS: integerKnob(7, 1, 13),
  R1_MEET_PUBLIC_SLOT_CAPACITY: integerKnob(2, 1, 15),
  R1_MEET_PUBLIC_BROWSER_HEADROOM: integerKnob(0, 0, 14),
  R1_MEET_PUBLIC_DAILY_CAP: integerKnob(20, 1, 200),
  R1_MEET_PUBLIC_MAX_MOVES: integerKnob(3, 0, 10),
  R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES: integerKnob(30, 15, 720),
  R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS: integerKnob(30, 1, 365),
}) satisfies Readonly<Partial<Record<R1MeetPublicEnvName, R1MeetPublicIntegerKnob>>>;
export type R1MeetPublicIntegerKnobName = keyof typeof R1_MEET_PUBLIC_INTEGER_KNOBS;

/** The slot grid step: exactly one of these (minutes). */
export const R1_MEET_PUBLIC_SLOT_STEP_MINUTES_CHOICES = Object.freeze([15, 30, 60] as const);
export const R1_MEET_PUBLIC_SLOT_STEP_MINUTES_DEFAULT = 30;
/** First and last IST slot START ("9am-9pm, every day": the last 45-minute slot starts at 20:30). */
export const R1_MEET_PUBLIC_HOURS_IST_DEFAULT = '09:00-20:30';
/** No public slot starts before 09:00 IST (minutes after IST midnight). */
export const R1_MEET_PUBLIC_EARLIEST_START_MINUTE_IST = 540;
export const R1_MEET_PUBLIC_DAYS_DEFAULT = 'mon-sun';
export const R1_MEET_PUBLIC_CLOSED_DATES_MAX = 100;
/** Owner decision 3: open applications without an R1 stage may book. */
export const R1_MEET_PUBLIC_REQUIRE_R1_STAGE_DEFAULT = false;
export const R1_MEET_PUBLIC_PRESLOT_RECHECK_DEFAULT = true;
/** The decoded service-account JSON key, at most (bytes). */
export const R1_MEET_GOOGLE_SA_KEY_MAX_BYTES = 8192;

export type R1MeetPublicConfig =
  | { readonly status: 'off' }
  | { readonly status: 'invalid'; readonly reason: string }
  | {
      readonly status: 'on';
      readonly google: R1MeetGoogleSettings; // secret fields NON-ENUMERABLE, like R1MeetRecallSettings
      readonly meetMode: 'calendar' | 'space';
      readonly botMode: 'guest' | 'signed_in'; // guest (DEFAULT) when R1_MEET_GOOGLE_LOGIN_GROUP_ID is unset
      readonly slot: R1MeetPublicSlotRules;
      readonly maxMoves: number;
      readonly manageCutoffMinutes: number;
      readonly requireR1Stage: boolean;
      readonly calendarRetentionDays: number;
      readonly preSlotRecheck: boolean;
      readonly serviceUserId: string; // from the Meet config, never null when on
      readonly dailyBotCap: number; // R1_MEET_DAILY_BOT_CAP, from the Meet config
      readonly bookPageUrl: string; // <first WEB_ORIGIN>/book
      readonly managePageUrl: string; // <first WEB_ORIGIN>/book/manage
    };

export type R1MeetGoogleSettings =
  | {
      readonly authMode: 'oauth_refresh'; // DEFAULT: the Dex user's own OAuth grant
      readonly dexEmail: string;
      readonly clientId: string;
      readonly clientSecret: string; // non-enumerable
      readonly refreshToken: string; // non-enumerable
    }
  | {
      readonly authMode: 'service_account'; // only for a dedicated Dex Workspace
      readonly dexEmail: string;
      readonly clientEmail: string;
      readonly privateKeyId: string; // non-enumerable
      readonly privateKey: string; // non-enumerable, PEM
    };

export interface R1MeetPublicSlotRules {
  readonly slotMinutes: number;
  readonly stepMinutes: number;
  readonly firstStartMinuteIst: number; // minutes after IST midnight (09:00 = 540)
  readonly lastStartMinuteIst: number; // 20:30 = 1230
  readonly isoWeekdays: readonly number[]; // 1 = Monday .. 7 = Sunday, sorted, unique
  readonly closedDates: readonly string[]; // 'YYYY-MM-DD', sorted, unique
  readonly minNoticeMinutes: number;
  readonly horizonDays: number;
  readonly slotCapacity: number;
  readonly browserHeadroom: number;
  readonly publicDailyCap: number;
}

/** The Google half of the drain: Dex's account only, read whatever the flags say. */
export type R1MeetPublicDrainConfig =
  | { readonly available: false }
  | { readonly available: true; readonly google: R1MeetGoogleSettings };

/**
 * What the one-time consent helper (scripts/m035-google-oauth-consent.ts) may take from the
 * environment. Each value is null when unset, a placeholder or malformed. `clientSecret` is
 * NON-ENUMERABLE: read it by name.
 */
export interface R1MeetGoogleOAuthClientInputs {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly dexEmail: string | null;
  readonly meetMode: 'calendar' | 'space' | null;
}

const PUBLIC_FLAG_REASON = 'R1_MEET_PUBLIC_BOOKING_ENABLED must be either "true" or "false"';
const AUTH_MODE_REASON = 'R1_MEET_GOOGLE_AUTH_MODE must be "oauth_refresh" or "service_account"';
const MEET_MODE_REASON = 'R1_MEET_GOOGLE_MEET_MODE must be "calendar" or "space"';
const SLOT_STEP_REASON = 'R1_MEET_PUBLIC_SLOT_STEP_MINUTES must be 15, 30 or 60';
const HOURS_REASON =
  'R1_MEET_PUBLIC_HOURS_IST must be HH:MM-HH:MM: first start at 09:00 or later, last start not before it, both on the R1_MEET_PUBLIC_SLOT_STEP_MINUTES grid, and the last slot ending by 24:00';
const DAYS_REASON = 'R1_MEET_PUBLIC_DAYS must be a comma list of mon..sun days or ascending ranges such as mon-fri';
const CLOSED_DATES_REASON = 'R1_MEET_PUBLIC_CLOSED_DATES must be a comma list of at most 100 real YYYY-MM-DD dates';
const MEET_NOT_ENABLED_REASON =
  'R1_MEET_PUBLIC_BOOKING_ENABLED is "true" but the Meet configuration is not enabled (R1_MEET_ENABLED)';
const SERVICE_USER_REQUIRED_REASON =
  'R1_MEET_SERVICE_USER_ID is required when R1_MEET_PUBLIC_BOOKING_ENABLED is "true"';
const DEX_EMAIL_REQUIRED_REASON = 'R1_MEET_GOOGLE_DEX_EMAIL is required when R1_MEET_PUBLIC_BOOKING_ENABLED is "true"';
const PUBLIC_UNEXPECTED_REASON = 'unexpected error while reading the public booking configuration';

/** The Google values, in check order (Dex's email, then each mode's credentials). */
type R1MeetGoogleValueName =
  | 'R1_MEET_GOOGLE_DEX_EMAIL'
  | 'R1_MEET_GOOGLE_OAUTH_CLIENT_ID'
  | 'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET'
  | 'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN'
  | 'R1_MEET_GOOGLE_SA_KEY_B64';
const malformedReason = (name: R1MeetGoogleValueName, detail = ''): string => `${name} is malformed${detail}`;
const GOOGLE_MALFORMED_REASON: Readonly<Record<R1MeetGoogleValueName, string>> = {
  R1_MEET_GOOGLE_DEX_EMAIL: 'R1_MEET_GOOGLE_DEX_EMAIL must be one email address of at most 254 characters',
  R1_MEET_GOOGLE_OAUTH_CLIENT_ID:
    'R1_MEET_GOOGLE_OAUTH_CLIENT_ID must end with .apps.googleusercontent.com (at most 200 characters, no spaces)',
  R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: malformedReason('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET'),
  R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: malformedReason('R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN'),
  R1_MEET_GOOGLE_SA_KEY_B64: malformedReason(
    'R1_MEET_GOOGLE_SA_KEY_B64',
    ' (expected base64 of a service-account JSON key)',
  ),
};
/** Each auth mode's credentials, in check order. The other mode's variables are never read. */
const GOOGLE_CREDENTIAL_VARIABLES = Object.freeze({
  oauth_refresh: Object.freeze([
    'R1_MEET_GOOGLE_OAUTH_CLIENT_ID',
    'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET',
    'R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN',
  ] as const),
  service_account: Object.freeze(['R1_MEET_GOOGLE_SA_KEY_B64'] as const),
});

const integerReason = (name: R1MeetPublicIntegerKnobName): string => {
  const { min, max } = R1_MEET_PUBLIC_INTEGER_KNOBS[name];
  return `${name} must be an integer from ${min} to ${max}`;
};
const booleanReason = (name: 'R1_MEET_PUBLIC_REQUIRE_R1_STAGE' | 'R1_MEET_PUBLIC_PRESLOT_RECHECK'): string =>
  `${name} must be either "true" or "false"`;
const credentialRequiredReason = (name: R1MeetGoogleValueName, mode: R1MeetGoogleAuthMode): string =>
  `${name} is required when R1_MEET_GOOGLE_AUTH_MODE is "${mode}"`;

// The `replace_me` placeholder counts as unset in the three Google secret slots (the rule of
// `isSet` above for the Recall pair), so a copied `.env.example` is "off", not "malformed".
const PUBLIC_SECRET_NAMES: ReadonlySet<string> = new Set(R1_MEET_PUBLIC_SECRET_VARIABLES);
function publicIsSet(name: R1MeetPublicEnvName, value: unknown): boolean {
  if (PUBLIC_SECRET_NAMES.has(name) && value === CREDENTIAL_PLACEHOLDER) return false;
  return present(value);
}

/** Blank = the default; else exactly one of `choices`; `undefined` = invalid. */
function parseChoice<T extends string>(raw: unknown, choices: readonly T[], fallback: T): T | undefined {
  if (!present(raw)) return fallback;
  return choices.find((choice) => choice === raw);
}

/** `null` = invalid. Never clamped (`parseCap` rule). */
function parsePublicInteger(raw: unknown, knob: R1MeetPublicIntegerKnob): number | null {
  if (!present(raw)) return knob.default;
  if (typeof raw !== 'string' || !DIGITS.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= knob.min && value <= knob.max ? value : null;
}

/** `null` = invalid. */
function parseSlotStep(raw: unknown): number | null {
  if (!present(raw)) return R1_MEET_PUBLIC_SLOT_STEP_MINUTES_DEFAULT;
  if (typeof raw !== 'string' || !DIGITS.test(raw)) return null;
  const value = Number(raw);
  return R1_MEET_PUBLIC_SLOT_STEP_MINUTES_CHOICES.find((step) => step === value) ?? null;
}

/** Blank = `fallback`; else exactly "true" or "false"; `undefined` = invalid. */
function parsePublicBoolean(raw: unknown, fallback: boolean): boolean | undefined {
  if (!present(raw)) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

const MINUTES_PER_DAY = 24 * 60;
const HOURS_IST_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
/**
 * The first and last IST slot START. The default is validated too: it must fit the step and the
 * slot length like any configured value (`09:00-20:30` with a 60-minute step is invalid). `null` = invalid.
 */
function parseHoursIst(raw: unknown, stepMinutes: number, slotMinutes: number): { first: number; last: number } | null {
  const text: unknown = present(raw) ? raw : R1_MEET_PUBLIC_HOURS_IST_DEFAULT;
  if (typeof text !== 'string') return null;
  const match = HOURS_IST_RE.exec(text);
  if (match === null) return null;
  const first = Number(match[1]) * 60 + Number(match[2]);
  const last = Number(match[3]) * 60 + Number(match[4]);
  const ok =
    first >= R1_MEET_PUBLIC_EARLIEST_START_MINUTE_IST &&
    last >= first &&
    first % stepMinutes === 0 &&
    last % stepMinutes === 0 &&
    last + slotMinutes <= MINUTES_PER_DAY;
  return ok ? { first, last } : null;
}

const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_ITEM_RE = /^([a-z]{3})(?:-([a-z]{3}))?$/;
/** Sorted, unique ISO weekdays (1 = Monday). An empty item or a descending range is invalid. `null` = invalid. */
function parseDays(raw: unknown): readonly number[] | null {
  const text: unknown = present(raw) ? raw : R1_MEET_PUBLIC_DAYS_DEFAULT;
  if (typeof text !== 'string') return null;
  const days = new Set<number>();
  for (const item of text.split(',')) {
    const match = DAY_ITEM_RE.exec(item.trim().toLowerCase());
    if (match === null) return null;
    const from = DAY_NAMES.indexOf(match[1] as (typeof DAY_NAMES)[number]);
    const to = match[2] === undefined ? from : DAY_NAMES.indexOf(match[2] as (typeof DAY_NAMES)[number]);
    if (from < 0 || to < from) return null;
    for (let day = from; day <= to; day += 1) days.add(day + 1);
  }
  return Object.freeze([...days].sort((a, b) => a - b));
}

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
function isCalendarDate(text: string): boolean {
  const match = CALENDAR_DATE_RE.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day <= length;
}

const NO_CLOSED_DATES: readonly string[] = Object.freeze([]);
/** Blank = none; else at most 100 comma items (counted before de-duplication), each a real date. */
function parseClosedDates(raw: unknown): readonly string[] | null {
  if (!present(raw)) return NO_CLOSED_DATES;
  if (typeof raw !== 'string') return null;
  const items = raw.split(',');
  if (items.length > R1_MEET_PUBLIC_CLOSED_DATES_MAX) return null;
  const dates = new Set<string>();
  for (const item of items) {
    const date = item.trim();
    if (!isCalendarDate(date)) return null;
    dates.add(date);
  }
  return Object.freeze([...dates].sort());
}

// The account-email rule of integrations/google/token.ts (`isAccountEmail`), so a Dex email or a
// service-account email this module accepts is one the token sources accept: printable ASCII with
// no whitespace and none of `<>(),;:"\`, exactly one '@', a non-empty local part, and a dot inside
// the domain (not first, not last).
const ACCOUNT_EMAIL_MAX_LENGTH = 254;
const ACCOUNT_EMAIL_CHARS = /^[\x21-\x7e]+$/;
const ACCOUNT_EMAIL_FORBIDDEN = /[<>(),;:"\\]/;
function parseAccountEmail(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 3 || raw.length > ACCOUNT_EMAIL_MAX_LENGTH) return null;
  if (!ACCOUNT_EMAIL_CHARS.test(raw) || ACCOUNT_EMAIL_FORBIDDEN.test(raw)) return null;
  const parts = raw.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || domain.length < 3) return null;
  return domain.indexOf('.') > 0 && !domain.endsWith('.') ? raw : null;
}

// The shapes integrations/google/token.ts accepts (its constructors refuse anything else).
const OAUTH_CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,173}\.apps\.googleusercontent\.com$/;
const OAUTH_CLIENT_ID_MAX_LENGTH = 200;
const OAUTH_CLIENT_SECRET_RE = /^[\x21-\x7e]{1,200}$/;
const OAUTH_REFRESH_RE = /^[\x21-\x7e]{1,512}$/;
const SA_PRIVATE_KEY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function parseClientId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= OAUTH_CLIENT_ID_MAX_LENGTH && OAUTH_CLIENT_ID_RE.test(raw) ? raw : null;
}
function parseOpaque(raw: unknown, shape: RegExp): string | null {
  return typeof raw === 'string' && shape.test(raw) ? raw : null;
}

// The PKCS#8 PEM armour lines, assembled from parts so no armour text is ever written contiguously
// in the source (the secret scanners match it).
const PEM_DASHES = '-'.repeat(5);
const PKCS8_LABEL = ['PRIVATE', 'KEY'].join(' ');
const PKCS8_HEADER = `${PEM_DASHES}BEGIN ${PKCS8_LABEL}${PEM_DASHES}`;
const PKCS8_FOOTER = `${PEM_DASHES}END ${PKCS8_LABEL}${PEM_DASHES}`;
const STANDARD_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SA_KEY_MAX_BASE64_LENGTH = Math.ceil(R1_MEET_GOOGLE_SA_KEY_MAX_BYTES / 3) * 4;

interface R1MeetServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKeyId: string;
  readonly privateKey: string;
}

/**
 * Standard base64 (padding optional) of a service-account JSON key, decoded at most 8 KB of UTF-8: a
 * JSON object with `type` "service_account", a `client_email`, a `private_key` holding the PKCS#8 PEM
 * armour and a `private_key_id`. Shape only: the RSA key itself is parsed by the token source on its
 * first use (this reader runs per request). `null` = malformed.
 */
function parseServiceAccountKey(raw: unknown): R1MeetServiceAccountKey | null {
  if (typeof raw !== 'string' || raw.length > SA_KEY_MAX_BASE64_LENGTH || !STANDARD_BASE64_RE.test(raw)) return null;
  if (raw.includes('=') ? raw.length % 4 !== 0 : raw.length % 4 === 1) return null;
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 0 || bytes.length > R1_MEET_GOOGLE_SA_KEY_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const key = parsed as Record<string, unknown>;
  if (key.type !== 'service_account') return null;
  const clientEmail = parseAccountEmail(key.client_email);
  if (clientEmail === null) return null;
  const privateKey = key.private_key;
  if (typeof privateKey !== 'string') return null;
  const header = privateKey.indexOf(PKCS8_HEADER);
  if (header < 0 || privateKey.indexOf(PKCS8_FOOTER, header + PKCS8_HEADER.length) < 0) return null;
  const privateKeyId = key.private_key_id;
  if (typeof privateKeyId !== 'string' || !SA_PRIVATE_KEY_ID_RE.test(privateKeyId)) return null;
  return { clientEmail, privateKeyId, privateKey };
}

/** What the Google readers read: the auth mode, Dex's email and both modes' credentials. */
export type R1MeetGoogleEnvSource = Pick<R1MeetEnvSource, R1MeetGoogleValueName | 'R1_MEET_GOOGLE_AUTH_MODE'>;

/**
 * Dex's Google settings for `authMode`, or the fixed reason of the first problem: Dex's email and
 * then the mode's credentials present (in order), then each well formed in the same order. The
 * other mode's variables are never read.
 */
function readGoogleSettings(env: R1MeetGoogleEnvSource, authMode: R1MeetGoogleAuthMode): R1MeetGoogleSettings | string {
  if (!publicIsSet('R1_MEET_GOOGLE_DEX_EMAIL', env.R1_MEET_GOOGLE_DEX_EMAIL)) return DEX_EMAIL_REQUIRED_REASON;
  for (const name of GOOGLE_CREDENTIAL_VARIABLES[authMode]) {
    if (!publicIsSet(name, env[name])) return credentialRequiredReason(name, authMode);
  }
  const email = parseAccountEmail(env.R1_MEET_GOOGLE_DEX_EMAIL);
  if (email === null) return GOOGLE_MALFORMED_REASON.R1_MEET_GOOGLE_DEX_EMAIL;
  const dexEmail = email.toLowerCase();

  if (authMode === 'oauth_refresh') {
    const clientId = parseClientId(env.R1_MEET_GOOGLE_OAUTH_CLIENT_ID);
    if (clientId === null) return GOOGLE_MALFORMED_REASON.R1_MEET_GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = parseOpaque(env.R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET, OAUTH_CLIENT_SECRET_RE);
    if (clientSecret === null) return GOOGLE_MALFORMED_REASON.R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = parseOpaque(env.R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN, OAUTH_REFRESH_RE);
    if (refreshToken === null) return GOOGLE_MALFORMED_REASON.R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN;
    return withHiddenCredentials(
      { authMode: 'oauth_refresh' as const, dexEmail, clientId },
      { clientSecret, refreshToken },
    ) as R1MeetGoogleSettings;
  }

  const key = parseServiceAccountKey(env.R1_MEET_GOOGLE_SA_KEY_B64);
  if (key === null) return GOOGLE_MALFORMED_REASON.R1_MEET_GOOGLE_SA_KEY_B64;
  return withHiddenCredentials(
    { authMode: 'service_account' as const, dexEmail, clientEmail: key.clientEmail },
    { privateKeyId: key.privateKeyId, privateKey: key.privateKey },
  ) as R1MeetGoogleSettings;
}

const PUBLIC_OFF: R1MeetPublicConfig = Object.freeze({ status: 'off' as const });
/** Silent on purpose: the caller raises `r1_meet_public_setup_error` with this fixed reason. */
function publicInvalid(reason: string): R1MeetPublicConfig {
  return Object.freeze({ status: 'invalid' as const, reason });
}

/**
 * The public booking link's configuration (M035). NEVER throws and logs nothing of its own. `source`
 * is a test seam, as for `getR1MeetConfig`.
 *
 *   R1_MEET_PUBLIC_BOOKING_ENABLED unset, blank or exactly "false" -> `off` (nothing else is read)
 *   any other value than exactly "true"                           -> `invalid`
 *   "true": the first failure below is the reason                 -> `invalid`, else `on`
 *
 * Check order: the knobs in contract §2 table order (auth mode, Meet mode, slot minutes, step,
 * hours, days, closed dates, notice, horizon, capacity, headroom, daily cap, moves, manage cutoff,
 * R1-stage rule, calendar retention, pre-slot recheck); then `getR1MeetConfig(source)` must be
 * `enabled` (it may log ITS OWN reason, once, as always); then its `serviceUserId` must be set;
 * then Dex's email and the chosen auth mode's credentials present, then well formed. The login
 * group is NOT required: unset = `botMode: 'guest'` (owner decision 2026-11-26).
 */
export function getR1MeetPublicConfig(source?: R1MeetEnvSource): R1MeetPublicConfig {
  try {
    const env: R1MeetEnvSource = source ?? readPublicProcessEnv();

    // Same strict rule as R1_MEET_ENABLED: only the exact text "true" turns it on.
    const flag: unknown = env.R1_MEET_PUBLIC_BOOKING_ENABLED;
    if (flag === undefined || flag === '' || flag === 'false') return PUBLIC_OFF;
    if (flag !== 'true') return publicInvalid(PUBLIC_FLAG_REASON);

    const authMode = parseChoice(env.R1_MEET_GOOGLE_AUTH_MODE, R1_MEET_GOOGLE_AUTH_MODES, R1_MEET_GOOGLE_AUTH_MODE_DEFAULT);
    if (authMode === undefined) return publicInvalid(AUTH_MODE_REASON);
    const meetMode = parseChoice(env.R1_MEET_GOOGLE_MEET_MODE, R1_MEET_GOOGLE_MEET_MODES, R1_MEET_GOOGLE_MEET_MODE_DEFAULT);
    if (meetMode === undefined) return publicInvalid(MEET_MODE_REASON);

    const integer = (name: R1MeetPublicIntegerKnobName): number | null =>
      parsePublicInteger(env[name], R1_MEET_PUBLIC_INTEGER_KNOBS[name]);

    const slotMinutes = integer('R1_MEET_PUBLIC_SLOT_MINUTES');
    if (slotMinutes === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_SLOT_MINUTES'));
    const stepMinutes = parseSlotStep(env.R1_MEET_PUBLIC_SLOT_STEP_MINUTES);
    if (stepMinutes === null) return publicInvalid(SLOT_STEP_REASON);
    const hours = parseHoursIst(env.R1_MEET_PUBLIC_HOURS_IST, stepMinutes, slotMinutes);
    if (hours === null) return publicInvalid(HOURS_REASON);
    const isoWeekdays = parseDays(env.R1_MEET_PUBLIC_DAYS);
    if (isoWeekdays === null) return publicInvalid(DAYS_REASON);
    const closedDates = parseClosedDates(env.R1_MEET_PUBLIC_CLOSED_DATES);
    if (closedDates === null) return publicInvalid(CLOSED_DATES_REASON);
    const minNoticeMinutes = integer('R1_MEET_PUBLIC_MIN_NOTICE_MINUTES');
    if (minNoticeMinutes === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_MIN_NOTICE_MINUTES'));
    const horizonDays = integer('R1_MEET_PUBLIC_HORIZON_DAYS');
    if (horizonDays === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_HORIZON_DAYS'));
    const slotCapacity = integer('R1_MEET_PUBLIC_SLOT_CAPACITY');
    if (slotCapacity === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_SLOT_CAPACITY'));
    const browserHeadroom = integer('R1_MEET_PUBLIC_BROWSER_HEADROOM');
    if (browserHeadroom === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_BROWSER_HEADROOM'));
    const publicDailyCap = integer('R1_MEET_PUBLIC_DAILY_CAP');
    if (publicDailyCap === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_DAILY_CAP'));
    const maxMoves = integer('R1_MEET_PUBLIC_MAX_MOVES');
    if (maxMoves === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_MAX_MOVES'));
    const manageCutoffMinutes = integer('R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES');
    if (manageCutoffMinutes === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_MANAGE_CUTOFF_MINUTES'));
    const requireR1Stage = parsePublicBoolean(env.R1_MEET_PUBLIC_REQUIRE_R1_STAGE, R1_MEET_PUBLIC_REQUIRE_R1_STAGE_DEFAULT);
    if (requireR1Stage === undefined) return publicInvalid(booleanReason('R1_MEET_PUBLIC_REQUIRE_R1_STAGE'));
    const calendarRetentionDays = integer('R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS');
    if (calendarRetentionDays === null) return publicInvalid(integerReason('R1_MEET_PUBLIC_CALENDAR_RETENTION_DAYS'));
    const preSlotRecheck = parsePublicBoolean(env.R1_MEET_PUBLIC_PRESLOT_RECHECK, R1_MEET_PUBLIC_PRESLOT_RECHECK_DEFAULT);
    if (preSlotRecheck === undefined) return publicInvalid(booleanReason('R1_MEET_PUBLIC_PRESLOT_RECHECK'));

    // The dependency, unchanged: the public reader only looks at the Meet answer.
    const meet = getR1MeetConfig(env);
    if (!meet.enabled) return publicInvalid(MEET_NOT_ENABLED_REASON);
    if (meet.serviceUserId === null) return publicInvalid(SERVICE_USER_REQUIRED_REASON);

    const google = readGoogleSettings(env, authMode);
    if (typeof google === 'string') return publicInvalid(google);

    // The Meet config derived its URLs on the first WEB_ORIGIN entry: the public pages use the same.
    const origin = new URL(meet.bridgePageUrl).origin;
    return Object.freeze({
      status: 'on' as const,
      google,
      meetMode,
      botMode: meet.recall.googleLoginGroupId === null ? ('guest' as const) : ('signed_in' as const),
      slot: Object.freeze({
        slotMinutes,
        stepMinutes,
        firstStartMinuteIst: hours.first,
        lastStartMinuteIst: hours.last,
        isoWeekdays,
        closedDates,
        minNoticeMinutes,
        horizonDays,
        slotCapacity,
        browserHeadroom,
        publicDailyCap,
      }),
      maxMoves,
      manageCutoffMinutes,
      requireR1Stage,
      calendarRetentionDays,
      preSlotRecheck,
      serviceUserId: meet.serviceUserId,
      dailyBotCap: meet.dailyBotCap,
      bookPageUrl: `${origin}${R1_MEET_PUBLIC_BOOK_PAGE_PATH}`,
      managePageUrl: `${origin}${R1_MEET_PUBLIC_MANAGE_PAGE_PATH}`,
    });
  } catch {
    // Defensive (e.g. a throwing getter on the source): this reader never throws either.
    return publicInvalid(PUBLIC_UNEXPECTED_REASON);
  }
}

/** Public booking work may run only when R1, Meet AND the public configuration are all on. */
export function r1MeetPublicActive(
  r1: { readonly enabled: boolean },
  meet: R1MeetConfig,
  pub: R1MeetPublicConfig,
): boolean {
  return r1.enabled === true && meet.enabled === true && pub.status === 'on';
}

const PUBLIC_DRAIN_UNAVAILABLE: R1MeetPublicDrainConfig = Object.freeze({ available: false as const });

/**
 * The Google half of the drain: Dex's account, whatever the flags say (like `getR1MeetDrainConfig`),
 * so calendar events can still be cancelled after the public flag is turned off. Reads only
 * R1_MEET_GOOGLE_AUTH_MODE, R1_MEET_GOOGLE_DEX_EMAIL and the chosen mode's credentials. Silent and
 * NEVER throws: anything absent, placeholder or malformed = `available: false`. Grants nothing by
 * itself.
 */
export function getR1MeetPublicDrainConfig(source?: R1MeetGoogleEnvSource): R1MeetPublicDrainConfig {
  try {
    const env: R1MeetGoogleEnvSource = source ?? {
      R1_MEET_GOOGLE_AUTH_MODE: process.env.R1_MEET_GOOGLE_AUTH_MODE,
      R1_MEET_GOOGLE_DEX_EMAIL: process.env.R1_MEET_GOOGLE_DEX_EMAIL,
      R1_MEET_GOOGLE_OAUTH_CLIENT_ID: process.env.R1_MEET_GOOGLE_OAUTH_CLIENT_ID,
      R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: process.env.R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET,
      R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN: process.env.R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN,
      R1_MEET_GOOGLE_SA_KEY_B64: process.env.R1_MEET_GOOGLE_SA_KEY_B64,
    };
    const authMode = parseChoice(env.R1_MEET_GOOGLE_AUTH_MODE, R1_MEET_GOOGLE_AUTH_MODES, R1_MEET_GOOGLE_AUTH_MODE_DEFAULT);
    if (authMode === undefined) return PUBLIC_DRAIN_UNAVAILABLE;
    const google = readGoogleSettings(env, authMode);
    if (typeof google === 'string') return PUBLIC_DRAIN_UNAVAILABLE;
    return Object.freeze({ available: true as const, google });
  } catch {
    return PUBLIC_DRAIN_UNAVAILABLE;
  }
}

/** What `getR1MeetGoogleOAuthClientInputs` reads (the consent helper passes typed values this way). */
export type R1MeetGoogleOAuthClientInputSource = Pick<
  R1MeetEnvSource,
  | 'R1_MEET_GOOGLE_OAUTH_CLIENT_ID'
  | 'R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET'
  | 'R1_MEET_GOOGLE_DEX_EMAIL'
  | 'R1_MEET_GOOGLE_MEET_MODE'
>;

const NO_OAUTH_CLIENT_INPUTS = withHiddenCredentials(
  { clientId: null, dexEmail: null, meetMode: null },
  { clientSecret: null },
) as R1MeetGoogleOAuthClientInputs;

/**
 * What the consent helper may take from the environment (it reads env only through this module).
 * Reads exactly R1_MEET_GOOGLE_OAUTH_CLIENT_ID, R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET,
 * R1_MEET_GOOGLE_DEX_EMAIL and R1_MEET_GOOGLE_MEET_MODE. Each is null when unset, the placeholder
 * (the secret) or malformed; a blank Meet mode is `calendar`; the email is lower-cased. The helper
 * validates typed values by passing them in as `source`. Silent and NEVER throws.
 */
export function getR1MeetGoogleOAuthClientInputs(
  source?: R1MeetGoogleOAuthClientInputSource,
): R1MeetGoogleOAuthClientInputs {
  try {
    const env: R1MeetGoogleOAuthClientInputSource = source ?? {
      R1_MEET_GOOGLE_OAUTH_CLIENT_ID: process.env.R1_MEET_GOOGLE_OAUTH_CLIENT_ID,
      R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET: process.env.R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET,
      R1_MEET_GOOGLE_DEX_EMAIL: process.env.R1_MEET_GOOGLE_DEX_EMAIL,
      R1_MEET_GOOGLE_MEET_MODE: process.env.R1_MEET_GOOGLE_MEET_MODE,
    };
    const clientId = parseClientId(env.R1_MEET_GOOGLE_OAUTH_CLIENT_ID);
    const rawSecret: unknown = env.R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET;
    const clientSecret = publicIsSet('R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET', rawSecret)
      ? parseOpaque(rawSecret, OAUTH_CLIENT_SECRET_RE)
      : null;
    const dexEmail = parseAccountEmail(env.R1_MEET_GOOGLE_DEX_EMAIL)?.toLowerCase() ?? null;
    const meetMode =
      parseChoice(env.R1_MEET_GOOGLE_MEET_MODE, R1_MEET_GOOGLE_MEET_MODES, R1_MEET_GOOGLE_MEET_MODE_DEFAULT) ?? null;
    return withHiddenCredentials({ clientId, dexEmail, meetMode }, { clientSecret }) as R1MeetGoogleOAuthClientInputs;
  } catch {
    return NO_OAUTH_CLIENT_INPUTS;
  }
}
