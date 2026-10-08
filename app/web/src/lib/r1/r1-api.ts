/**
 * Typed client for the candidate-facing R1 routes (plan section 8.3, PR-3).
 *
 * The wire shapes below are PR-3's, as implemented in `app/api/src/routes/
 * r1-candidate.ts` and documented in `app/api/openapi/openapi.yaml`: the
 * client adapts to the server, not the reverse. Every route path, request
 * field and response field the R1 web depends on is declared in THIS file and
 * nowhere else (`R1_ROUTES`, `R1_CONTRACT`, the `parse*` functions), and
 * `r1-contract.test.ts` fails CI when `openapi.yaml` stops documenting one of
 * them. The page-facing models (`R1Status`, `R1AttemptGrant`) are normalised
 * from the wire here, so a wire change never reaches the components. Wire
 * fields are snake_case, like every other route.
 *
 * Invariants:
 *   - The link token and the attempt token travel in the JSON body, never in a
 *     URL, a header or a log line.
 *   - Requests are credential-free: the R1 routes authenticate by link token,
 *     so the recruiter's Supabase bearer must never be attached (a recruiter
 *     previewing a link in the same browser would otherwise leak it).
 *   - Responses are validated and normalised here. A response that does not
 *     have the expected shape fails closed as `r1_malformed_response`; the
 *     pages never see raw server JSON.
 *   - Only the machine code of an error is surfaced, never server prose.
 */

import { ApiError, apiClient } from '../api-client';

export const R1_ROUTES = Object.freeze({
  status: '/api/r1/status',
  consentTemplate: '/api/r1/consent-template',
  consent: '/api/r1/consent',
  consentWithdraw: '/api/r1/consent/withdraw',
  preflight: '/api/r1/preflight',
  attempts: '/api/r1/attempts',
  exchange: '/api/r1/exchange',
  ready: '/api/r1/ready',
});

/**
 * What this client sends to, and requires back from, each route. It is the one
 * statement of the wire contract the web depends on: `r1Api` below builds its
 * requests from the methods here, and `r1-contract.test.ts` checks the real
 * requests, the `parse*` functions and `app/api/openapi/openapi.yaml` against
 * it, so drift fails CI instead of showing every invited candidate "We could
 * not open this link".
 *
 * The link token is the `token` field of every request body. It never travels
 * in a URL, a query string or a header.
 *
 * `consentTemplate` is a POST that carries the link token in the body. The plan
 * section 8.3 table listed it as `GET`, but a GET can carry the token only in the
 * URL or a header, and the notice must be the one THIS link's audience is owed
 * (candidate or staff dry run), which only the server can know from the round.
 * No request carries a locale: the audience is server-owned (PR-CT, 0123), and
 * the server refuses a request that names one.
 *
 * Where PR-3 sends more than the page reads (the status `expires_at`, the
 * attempt `attempt_number`, the preflight pass policy) the extra fields are
 * simply not declared here: this contract lists only what the web depends on.
 */
export interface R1RouteContract {
  method: 'GET' | 'POST';
  path: string;
  /** JSON body fields sent on every call. */
  request: readonly string[];
  /** JSON body fields sent only on some calls. */
  requestOptional: readonly string[];
  /** Success-response fields the parser REQUIRES: it rejects the response without them. */
  response: readonly string[];
  /** Success-response fields read when present. */
  responseOptional: readonly string[];
}

export type R1RouteName = keyof typeof R1_ROUTES;

const route = (
  name: R1RouteName,
  shape: Omit<R1RouteContract, 'method' | 'path'>,
): R1RouteContract => Object.freeze({ method: 'POST', path: R1_ROUTES[name], ...shape });

export const R1_CONTRACT: Readonly<Record<R1RouteName, R1RouteContract>> = Object.freeze({
  status: route('status', {
    request: ['token'],
    requestOptional: [],
    response: ['round_status', 'availability', 'attempts_remaining', 'consent'],
    // The page reads these when present and falls back to the stricter reading when a
    // server that predates them omits them: `audience` to `candidate`, the counts and
    // flags to "unknown", which never closes a link.
    responseOptional: [
      'role_title',
      'format',
      'audience',
      'attempts_allowed',
      'starts_remaining',
      'live_attempt',
      'can_start',
    ],
  }),
  consentTemplate: route('consentTemplate', {
    request: ['token'],
    requestOptional: [],
    response: ['version', 'locale', 'title', 'body_md', 'required_consents'],
    responseOptional: ['consent_items'],
  }),
  consent: route('consent', {
    request: ['token', 'template_version', 'consents', 'status'],
    requestOptional: [],
    response: [],
    responseOptional: [],
  }),
  consentWithdraw: route('consentWithdraw', {
    request: ['token'],
    requestOptional: [],
    response: [],
    responseOptional: [],
  }),
  preflight: route('preflight', {
    request: ['token'],
    requestOptional: [],
    response: ['url', 'livekit_token'],
    responseOptional: ['expires_at', 'policy_version'],
  }),
  // `nonce` is in the response of a NEW attempt (201) only: a rejoin (200) is a
  // fresh attempt token for the attempt the page already holds the nonce of.
  // There is no `lead`: PR-3 never returns the persona (the spec's attempt schemas are
  // closed), so the role-play card keeps its generic wording. `parseAttempt` still
  // sanitises a `lead` should a later PR supply one, but nothing here declares it until
  // that PR documents it in openapi.yaml and adds it to this contract.
  // `attempt_token_expires_at` says when the token stops being accepted (five minutes after it is
  // minted): the page reads it to know whether the token it holds still serves "I'm ready".
  attempts: route('attempts', {
    request: ['token'],
    requestOptional: ['nonce'],
    response: ['attempt_token'],
    responseOptional: ['nonce', 'attempt_id', 'rejoin', 'attempt_token_expires_at'],
  }),
  // `status` is `preparing` on the 202 while a worker boots.
  exchange: route('exchange', {
    request: ['attempt_token', 'nonce'],
    requestOptional: [],
    response: ['url', 'livekit_token'],
    responseOptional: ['status', 'expires_at', 'attempt_id'],
  }),
  // "I'm ready" during the role-play briefing: the server relays it to the interviewer in the
  // room (the candidate's room token cannot publish data, so the browser cannot). Same body as
  // the exchange, and the attempt token it carries must be a current one (they last five
  // minutes). The page keeps the token it was last given (with its `attempt_token_expires_at`)
  // and asks the rejoin branch of `attempts` for a new one only when that one is spent or about
  // to be (R1JoinPage `sendReady`). That rejoin call is subject to the admission gates (round
  // expiry, R1 switched off) and to the per-link start rate limit.
  // The 200 body is `{ok:true}`; the page needs only the status, so no response field is
  // declared or parsed.
  ready: route('ready', {
    request: ['attempt_token', 'nonce'],
    requestOptional: [],
    response: [],
    responseOptional: [],
  }),
});

export type R1RoundState = 'invited' | 'in_progress' | 'completed' | 'expired' | 'cancelled';

const ROUND_STATES: readonly string[] = [
  'invited',
  'in_progress',
  'completed',
  'expired',
  'cancelled',
];

/** Whether R1 is taking new interviews: open, paused by the budget guard, or switched off. */
export type R1Availability = 'open' | 'paused' | 'disabled';

const AVAILABILITIES: readonly string[] = ['open', 'paused', 'disabled'];

/**
 * The server's reading of the round's consent: only `granted` lets the interview start.
 * `declined` and `withdrawn` are the person's own, final choice on this page (the server
 * would take a new grant, but the page does not offer one: it tells them no interview will
 * be held with this link), unlike `required`, which asks.
 */
export type R1ConsentState = 'granted' | 'required' | 'declined' | 'withdrawn';

const CONSENT_STATES: readonly string[] = ['granted', 'required', 'declined', 'withdrawn'];

/** Whom the page is talking to: a candidate, or staff on an internal dry run. */
export type R1Audience = 'candidate' | 'staff';

/**
 * The closed vocabularies `parseStatus` accepts. A value outside them fails closed, so a
 * server that grows a new one would show every candidate the "unavailable" screen;
 * `r1-contract.test.ts` pins these to the enums `openapi.yaml` documents.
 */
export const R1_STATUS_VOCABULARY = Object.freeze({
  round_status: ROUND_STATES,
  availability: AVAILABILITIES,
  consent_state: CONSENT_STATES,
});

/**
 * `POST /api/r1/status`, as the page uses it. The wire names are PR-3's
 * (`round_status`, `attempts_remaining`, `consent.state`, `availability`);
 * `parseStatus` maps them onto this model.
 */
export interface R1Status {
  state: R1RoundState;
  attempts_left: number;
  /** The attempts the link allows in all, or null when the server did not say. */
  attempts_allowed: number | null;
  /** Interview starts the link has left, or null when the server did not say. */
  starts_left: number | null;
  /** The server's own verdict on starting now, or null when it did not say. */
  can_start: boolean | null;
  /** An attempt of this link is live (here or elsewhere), or null when the server did not say. */
  live_attempt: boolean | null;
  /** `granted` only when the round holds a live, valid consent for the current notice. */
  consent_state: R1ConsentState;
  role_title: string | null;
  format: { duration_minutes: number | null };
  /** Anything but `open` leaves the link valid and the candidate waiting. */
  availability: R1Availability;
  /** `staff` for an internal dry run (its closing screens speak for the project team). */
  audience: R1Audience;
}

export interface R1ConsentItem {
  type: string;
  label: string;
}

/** `POST /api/r1/consent-template`: the immutable, versioned notice (plan section 7.8). */
export interface R1ConsentTemplate {
  version: string;
  locale: string;
  title: string;
  body_md: string;
  required_consents: string[];
  consent_items: R1ConsentItem[];
}

/**
 * What the candidate decided. There is no locale: the notice a round is owed is
 * chosen by the server, so the candidate can neither pick nor forge it.
 */
export interface R1ConsentSubmission {
  template_version: string;
  /** The purposes the candidate agreed to; empty when declining. */
  consents: string[];
  status: 'granted' | 'declined';
}

/** `POST /api/r1/preflight`: a disposable room token for the 10 second A/V check. */
export interface R1PreflightGrant {
  url: string;
  livekit_token: string;
  expires_at: string | null;
  policy_version: string | null;
}

/** The role-play lead as the candidate is allowed to see it (name and city only). */
export interface R1LeadCard {
  name: string;
  city: string;
}

/**
 * `POST /api/r1/attempts`: the attempt token and the per-attempt rejoin nonce.
 * The server returns the nonce only for a NEW attempt; on a rejoin it is the
 * one the page sent, so `createAttempt` fills it in and the page always has it.
 */
export interface R1AttemptGrant {
  attempt_token: string;
  nonce: string;
  attempt_id: string | null;
  /** True when this token re-enters the attempt that was already live. */
  rejoin: boolean;
  lead: R1LeadCard | null;
  /** When `attempt_token` stops being accepted (ISO time), or null when the server did not say. */
  expires_at: string | null;
}

/** What `parseAttempt` reads off the wire, before a rejoin's nonce is filled in. */
export type R1AttemptResponse = Omit<R1AttemptGrant, 'nonce'> & { nonce: string | null };

export interface R1RoomGrant {
  status: 'ready';
  url: string;
  livekit_token: string;
  expires_at: string | null;
  attempt_id: string | null;
}

/** `POST /api/r1/exchange`: 200 with a room token, or 202 while the worker boots. */
export type R1ExchangeResult = R1RoomGrant | { status: 'preparing' };

export type R1ErrorKind =
  | 'busy'
  | 'attempt_not_live'
  | 'consent_required'
  | 'starts_exhausted'
  | 'attempts_exhausted'
  | 'link_invalid'
  | 'link_expired'
  | 'rate_limited'
  | 'unavailable'
  | 'network'
  | 'unknown';

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function malformed(): never {
  throw new ApiError('r1_malformed_response', 500);
}

function requireRecord(value: unknown): Json {
  return record(value) ?? malformed();
}

function requireString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : malformed();
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** A string the browser can read as a point in time, or null. */
function optionalTimestamp(value: unknown): string | null {
  const text = optionalString(value);
  return text !== null && Number.isFinite(Date.parse(text)) ? text : null;
}

function optionalFlag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function errorCode(data: unknown, status: number): string {
  const body = record(data);
  const code = body?.error;
  if (typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code)) return code;
  return `http_${status}`;
}

async function send(
  method: R1RouteContract['method'],
  path: string,
  body?: Json,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${apiClient.BASE_URL}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError('network_unreachable', 0);
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new ApiError(errorCode(data, response.status), response.status);
  return data;
}

/** Sanitise a lead field: letters, spaces and a few name punctuation marks, 40 characters. */
function leadField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\p{L}[\p{L} .'’-]{0,39}$/u.test(trimmed) ? trimmed : null;
}

export function normalizeLead(value: unknown): R1LeadCard | null {
  const lead = record(value);
  if (!lead) return null;
  const name = leadField(lead.name);
  const city = leadField(lead.city);
  return name && city ? { name, city } : null;
}

export function parseStatus(data: unknown): R1Status {
  const body = requireRecord(data);
  const state = requireString(body.round_status);
  if (!ROUND_STATES.includes(state)) malformed();
  const availability = requireString(body.availability);
  if (!AVAILABILITIES.includes(availability)) malformed();
  const attemptsLeft = optionalCount(body.attempts_remaining);
  if (attemptsLeft === null) malformed();
  const consent = requireRecord(body.consent);
  const consentState = requireString(consent.state);
  if (!CONSENT_STATES.includes(consentState)) malformed();
  const format = record(body.format);
  const minutes = format ? optionalCount(format.duration_minutes) : null;
  return {
    state: state as R1RoundState,
    attempts_left: attemptsLeft as number,
    attempts_allowed: optionalCount(body.attempts_allowed),
    starts_left: optionalCount(body.starts_remaining),
    can_start: optionalFlag(body.can_start),
    live_attempt: optionalFlag(body.live_attempt),
    consent_state: consentState as R1ConsentState,
    role_title: optionalString(body.role_title),
    format: { duration_minutes: minutes },
    availability: availability as R1Availability,
    // Anything but the staff notice reads as a candidate: the stricter wording.
    audience: body.audience === 'staff' ? 'staff' : 'candidate',
  };
}

export function parseConsentTemplate(data: unknown): R1ConsentTemplate {
  const body = requireRecord(data);
  const required = body.required_consents;
  if (!Array.isArray(required) || required.length === 0) malformed();
  const types = (required as unknown[]).map((item) => {
    const type = requireString(item);
    return /^[a-z][a-z0-9_]{1,40}$/.test(type) ? type : malformed();
  });
  const items: R1ConsentItem[] = [];
  if (Array.isArray(body.consent_items)) {
    for (const raw of body.consent_items as unknown[]) {
      const item = record(raw);
      const type = item ? optionalString(item.type) : null;
      const label = item ? optionalString(item.label) : null;
      if (type && label && types.includes(type)) items.push({ type, label });
    }
  }
  return {
    version: requireString(body.version),
    locale: requireString(body.locale),
    title: requireString(body.title),
    body_md: requireString(body.body_md),
    required_consents: types,
    consent_items: items,
  };
}

export function parsePreflight(data: unknown): R1PreflightGrant {
  const body = requireRecord(data);
  return {
    url: requireString(body.url),
    livekit_token: requireString(body.livekit_token),
    expires_at: optionalString(body.expires_at),
    policy_version: optionalString(body.policy_version),
  };
}

export function parseAttempt(data: unknown): R1AttemptResponse {
  const body = requireRecord(data);
  return {
    attempt_token: requireString(body.attempt_token),
    nonce: optionalString(body.nonce),
    attempt_id: optionalString(body.attempt_id),
    rejoin: body.rejoin === true,
    lead: normalizeLead(body.lead),
    expires_at: optionalTimestamp(body.attempt_token_expires_at),
  };
}

export function parseExchange(data: unknown): R1ExchangeResult {
  const body = requireRecord(data);
  if (body.status === 'preparing') return { status: 'preparing' };
  return {
    status: 'ready',
    url: requireString(body.url),
    livekit_token: requireString(body.livekit_token),
    expires_at: optionalString(body.expires_at),
    attempt_id: optionalString(body.attempt_id),
  };
}

const call = (name: R1RouteName, body: Json): Promise<unknown> =>
  send(R1_CONTRACT[name].method, R1_CONTRACT[name].path, body);

export const r1Api = {
  status: async (linkToken: string): Promise<R1Status> =>
    parseStatus(await call('status', { token: linkToken })),

  /**
   * The token travels in the body, and no locale is sent: the server owes this
   * link the notice of its own audience (candidate or staff dry run).
   */
  consentTemplate: async (linkToken: string): Promise<R1ConsentTemplate> =>
    parseConsentTemplate(await call('consentTemplate', { token: linkToken })),

  submitConsent: async (linkToken: string, submission: R1ConsentSubmission): Promise<void> => {
    await call('consent', { token: linkToken, ...submission });
  },

  withdrawConsent: async (linkToken: string): Promise<void> => {
    await call('consentWithdraw', { token: linkToken });
  },

  preflight: async (linkToken: string): Promise<R1PreflightGrant> =>
    parsePreflight(await call('preflight', { token: linkToken })),

  /**
   * `nonce` is sent only to rejoin an attempt within the grace window. The server
   * answers a rejoin without a nonce (the page already holds it), so it is filled
   * in here; a new attempt with no nonce in the answer is refused as malformed.
   */
  createAttempt: async (linkToken: string, nonce: string | null): Promise<R1AttemptGrant> => {
    const grant = parseAttempt(
      await call('attempts', {
        token: linkToken,
        ...(nonce ? { nonce } : {}),
      }),
    );
    const held = grant.nonce ?? nonce;
    return held ? { ...grant, nonce: held } : malformed();
  },

  exchange: async (attemptToken: string, nonce: string): Promise<R1ExchangeResult> =>
    parseExchange(await call('exchange', { attempt_token: attemptToken, nonce })),

  /**
   * Tell the interviewer, through the server, that the candidate pressed "I'm ready". Resolves
   * on any 2xx; a refusal (no live session, rate limit, a stale token) rejects with the error
   * code. The spoken "ready" keeps working either way, so a failure is never fatal.
   */
  ready: async (attemptToken: string, nonce: string): Promise<void> => {
    await call('ready', { attempt_token: attemptToken, nonce });
  },
};

/**
 * The machine codes the server answers that the page acts on, and what each means to it.
 * Every one is a code `app/api/src/routes/r1-candidate.ts` answers and `openapi.yaml`
 * names; `r1-contract.test.ts` fails CI when either side stops saying it, so a renamed
 * code cannot quietly turn a precise message into the generic one.
 */
const ERROR_KINDS: Readonly<Record<string, R1ErrorKind>> = Object.freeze({
  r1_busy: 'busy',
  // A rejoin named an attempt that is no longer live: the stored nonce is spent.
  r1_attempt_not_live: 'attempt_not_live',
  consent_required: 'consent_required',
  consent_template_stale: 'consent_required',
  starts_exhausted: 'starts_exhausted',
  attempts_exhausted: 'attempts_exhausted',
  round_expired: 'link_expired',
  consent_template_unavailable: 'unavailable',
  r1_unavailable: 'unavailable',
  r1_paused: 'unavailable',
  r1_disabled: 'unavailable',
  r1_capacity_exhausted: 'unavailable',
  service_unavailable: 'unavailable',
});

/** The server error codes `classifyR1Error` recognises by name. */
export const R1_SERVER_ERROR_CODES: readonly string[] = Object.freeze(Object.keys(ERROR_KINDS));

/** Map any thrown value to the small closed set the pages know how to explain. */
export function classifyR1Error(error: unknown): R1ErrorKind {
  if (!(error instanceof ApiError)) return 'unknown';
  if (Object.prototype.hasOwnProperty.call(ERROR_KINDS, error.message)) {
    return ERROR_KINDS[error.message] as R1ErrorKind;
  }
  if (error.status === 0) return 'network';
  if (error.status === 410) return 'link_expired';
  if (error.status === 429) return 'rate_limited';
  if ([502, 503, 504].includes(error.status)) return 'unavailable';
  if ([400, 401, 403, 404].includes(error.status)) return 'link_invalid';
  return 'unknown';
}
