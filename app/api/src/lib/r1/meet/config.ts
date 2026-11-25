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
 * This is the ONLY module that reads the Meet variables. The vendor modules (integrations/recall,
 * integrations/google-meet) read no environment at all and take the values below as explicit
 * arguments; `r1-room-isolation.test.ts` pins both rules. The credentials are Fly secrets on the
 * API (`project-hello-api`) only: never in fly.toml, never on the workers. Each variable is read as
 * a literal property of process.env (never a computed key) so `scripts/check-env-contract.mjs`
 * sees it.
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
 * Every variable this module owns (WEB_ORIGIN is shared and declared elsewhere): the flag, the
 * knobs, the Dex user id and the feedback form id first, then the two credentials.
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

function withHiddenCredentials<T extends object>(visible: T, hidden: Record<string, string>): T {
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
    const env = source ?? readProcessEnv();
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
