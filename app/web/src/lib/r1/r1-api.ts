/**
 * Typed client for the candidate-facing R1 routes (plan section 8.3, PR-3).
 *
 * RECONCILIATION POINT. PR-3 (`r1/pr3-api`) is built in parallel with the web
 * and only the plan's route table exists today, so every wire shape below is
 * PROVISIONAL until it is checked against the merged PR-3 handlers and
 * `openapi.yaml`. Every route path, request field and response field the R1
 * web depends on is declared in THIS file and nowhere else (`R1_ROUTES`,
 * `R1_CONTRACT`, the `parse*` functions), so reconciling means editing this
 * module, its tests and the e2e fake. `r1-contract.test.ts` refuses to let the
 * web outlive a drift once PR-3 documents its routes. Wire fields are
 * snake_case, like every other route.
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
});

/**
 * What this client sends to, and requires back from, each route. It is the one
 * statement of the wire contract the web depends on: `r1Api` below builds its
 * requests from the methods here, and `r1-contract.test.ts` checks the real
 * requests, the `parse*` functions and (once PR-3 documents the routes)
 * `app/api/openapi/openapi.yaml` against it, so drift fails CI instead of
 * showing every invited candidate "We could not open this link".
 *
 * `consentTemplate` is a POST that carries the link token in the body. The plan
 * section 8.3 table lists it as `GET` under link-token auth, but a GET can carry
 * the token only in the URL or a header, and this client never puts the token in
 * either. PR-3 must serve it as a POST (or fold the notice into `status`).
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
    request: ['link_token'],
    requestOptional: [],
    response: ['state', 'attempts_left', 'consent_required'],
    responseOptional: ['role_title', 'format', 'budget_paused'],
  }),
  consentTemplate: route('consentTemplate', {
    request: ['link_token', 'locale'],
    requestOptional: [],
    response: ['version', 'locale', 'title', 'body_md', 'required_consents'],
    responseOptional: ['consent_items'],
  }),
  consent: route('consent', {
    request: ['link_token', 'template_version', 'locale', 'consents', 'status'],
    requestOptional: [],
    response: [],
    responseOptional: [],
  }),
  consentWithdraw: route('consentWithdraw', {
    request: ['link_token'],
    requestOptional: [],
    response: [],
    responseOptional: [],
  }),
  preflight: route('preflight', {
    request: ['link_token'],
    requestOptional: [],
    response: ['url', 'livekit_token'],
    responseOptional: ['expires_at', 'policy_version'],
  }),
  attempts: route('attempts', {
    request: ['link_token'],
    requestOptional: ['nonce'],
    response: ['attempt_token', 'nonce'],
    responseOptional: ['session_id', 'lead', 'attempts_left'],
  }),
  exchange: route('exchange', {
    request: ['attempt_token', 'nonce'],
    requestOptional: [],
    response: ['url', 'livekit_token'],
    responseOptional: ['status', 'session_id'],
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

/** `POST /api/r1/status`: where the link stands, and what the candidate must do next. */
export interface R1Status {
  state: R1RoundState;
  attempts_left: number;
  /** True when no live consent exists for the current template version. */
  consent_required: boolean;
  role_title: string | null;
  format: { duration_minutes: number | null; summary: string | null };
  /** The monthly budget guard has paused R1; the link stays valid. */
  budget_paused: boolean;
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

export interface R1ConsentSubmission {
  template_version: string;
  locale: string;
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

/** `POST /api/r1/attempts`: the attempt token and the per-attempt rejoin nonce. */
export interface R1AttemptGrant {
  attempt_token: string;
  nonce: string;
  session_id: string | null;
  lead: R1LeadCard | null;
  attempts_left: number | null;
}

export interface R1RoomGrant {
  status: 'ready';
  url: string;
  livekit_token: string;
  session_id: string | null;
}

/** `POST /api/r1/exchange`: 200 with a room token, or 202 while the worker boots. */
export type R1ExchangeResult = R1RoomGrant | { status: 'preparing' };

export type R1ErrorKind =
  | 'busy'
  | 'consent_required'
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
  const state = requireString(body.state);
  if (!ROUND_STATES.includes(state)) malformed();
  const attemptsLeft = optionalCount(body.attempts_left);
  if (attemptsLeft === null || typeof body.consent_required !== 'boolean') malformed();
  const format = record(body.format);
  const minutes = format ? optionalCount(format.duration_minutes) : null;
  return {
    state: state as R1RoundState,
    attempts_left: attemptsLeft,
    consent_required: body.consent_required as boolean,
    role_title: optionalString(body.role_title),
    format: { duration_minutes: minutes, summary: format ? optionalString(format.summary) : null },
    budget_paused: body.budget_paused === true,
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

export function parseAttempt(data: unknown): R1AttemptGrant {
  const body = requireRecord(data);
  return {
    attempt_token: requireString(body.attempt_token),
    nonce: requireString(body.nonce),
    session_id: optionalString(body.session_id),
    lead: normalizeLead(body.lead),
    attempts_left: optionalCount(body.attempts_left),
  };
}

export function parseExchange(data: unknown): R1ExchangeResult {
  const body = requireRecord(data);
  if (body.status === 'preparing') return { status: 'preparing' };
  return {
    status: 'ready',
    url: requireString(body.url),
    livekit_token: requireString(body.livekit_token),
    session_id: optionalString(body.session_id),
  };
}

const call = (name: R1RouteName, body: Json): Promise<unknown> =>
  send(R1_CONTRACT[name].method, R1_CONTRACT[name].path, body);

export const r1Api = {
  status: async (linkToken: string): Promise<R1Status> =>
    parseStatus(await call('status', { link_token: linkToken })),

  /** The token travels in the body: the notice is fetched per link, never by URL. */
  consentTemplate: async (linkToken: string, locale: string): Promise<R1ConsentTemplate> =>
    parseConsentTemplate(await call('consentTemplate', { link_token: linkToken, locale })),

  submitConsent: async (linkToken: string, submission: R1ConsentSubmission): Promise<void> => {
    await call('consent', { link_token: linkToken, ...submission });
  },

  withdrawConsent: async (linkToken: string): Promise<void> => {
    await call('consentWithdraw', { link_token: linkToken });
  },

  preflight: async (linkToken: string): Promise<R1PreflightGrant> =>
    parsePreflight(await call('preflight', { link_token: linkToken })),

  /** `nonce` is sent only to rejoin an attempt within the grace window. */
  createAttempt: async (linkToken: string, nonce: string | null): Promise<R1AttemptGrant> =>
    parseAttempt(
      await call('attempts', {
        link_token: linkToken,
        ...(nonce ? { nonce } : {}),
      }),
    ),

  exchange: async (attemptToken: string, nonce: string): Promise<R1ExchangeResult> =>
    parseExchange(await call('exchange', { attempt_token: attemptToken, nonce })),
};

const BUSY_CODES = ['r1_busy'];
const CONSENT_CODES = ['consent_required', 'consent_withdrawn', 'consent_version_stale'];
const UNAVAILABLE_CODES = [
  'r1_unavailable',
  'r1_temporarily_unavailable',
  'r1_paused',
  'r1_disabled',
  'r1_capacity_exhausted',
  'service_unavailable',
];

/** Map any thrown value to the small closed set the pages know how to explain. */
export function classifyR1Error(error: unknown): R1ErrorKind {
  if (!(error instanceof ApiError)) return 'unknown';
  const code = error.message;
  if (BUSY_CODES.includes(code)) return 'busy';
  if (CONSENT_CODES.includes(code)) return 'consent_required';
  if (error.status === 0) return 'network';
  if (error.status === 410 || code === 'link_expired') return 'link_expired';
  if (error.status === 429) return 'rate_limited';
  if (UNAVAILABLE_CODES.includes(code) || [502, 503, 504].includes(error.status)) {
    return 'unavailable';
  }
  if ([400, 401, 403, 404].includes(error.status)) return 'link_invalid';
  return 'unknown';
}
