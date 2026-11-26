/**
 * An in-memory Google double for tests (M035 S03 T1), shared with the later S03 tasks and S05/S06.
 *
 * T1 implements the OAuth token endpoint `POST https://oauth2.googleapis.com/token`, behaving like
 * Google where it matters:
 * - `grant_type=refresh_token`: the client id and secret must match (else 401 `invalid_client`),
 *   the refresh token must match and not be revoked (else 400 `invalid_grant`). The answer carries
 *   `scope` = the granted scopes (`setGrantedScopes`), like Google's refresh response.
 * - `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`: the RS256 signature is verified with
 *   the service account's PUBLIC key given in the options (else 400 `invalid_grant`); `iss` must be
 *   the service account, `aud` the token URL, `exp - iat <= 3600` and `exp` in the future (else
 *   `invalid_grant`); `sub` must be the Dex email and every `scope` claim a granted scope (else 401
 *   `unauthorized_client`, Google's answer for an undelegated client or scope). No `scope` in the
 *   answer, like Google.
 * - Any other URL answers 404 with a Google-style JSON error (T3 adds Calendar and Meet).
 * - `failNext` injects one canned response for the next call, served ahead of the simulation.
 *
 * `calls` records `{method, url, path, query, headers, body}`: the authorization value replaced by
 * `<redacted>`, a form body decoded to an object, a JSON body parsed, anything else null. Access
 * tokens are issued as `at-<n>-aaaa...` (low entropy, never a real-looking token) and listed in
 * `tokensIssued`, so tests can prove none of them leaks.
 *
 * Fixtures are built at run time from low-entropy parts (S03 plan R18). Never shipped:
 * `tsconfig.build.json` excludes `src/__tests__`.
 */
import { verify, type KeyObject } from 'node:crypto';
import type {
  GoogleTransport,
  GoogleTransportRequest,
  GoogleTransportResponse,
} from '../../integrations/google/http.js';
import { GOOGLE_TOKEN_URL } from '../../integrations/google/http.js';
import { GOOGLE_JWT_BEARER_GRANT_TYPE, GOOGLE_SCOPES } from '../../integrations/google/token.js';

/** Low-entropy fixtures (never a real-looking credential). */
export const FAKE_GOOGLE_CLIENT_ID = ['hello', 'r1', 'fake'].join('-') + '.apps.googleusercontent.com';
export const FAKE_GOOGLE_CLIENT_SECRET = 'cs-' + 's'.repeat(32);
export const FAKE_GOOGLE_REFRESH_TOKEN = 'rt-' + 'r'.repeat(40);
export const FAKE_GOOGLE_DEX_EMAIL = 'dex@hello.example.test';
export const FAKE_GOOGLE_SA_EMAIL = 'hello-r1-dwd@hello-project.example.test';

/** The default grant: the two calendar-mode scopes. */
export const FAKE_GOOGLE_DEFAULT_SCOPES: readonly string[] = Object.freeze([
  GOOGLE_SCOPES.calendarEventsOwned,
  GOOGLE_SCOPES.meetSpaceSettings,
]);

const DEFAULT_NOW = () => Date.UTC(2026, 11, 1, 4, 30, 0);

export interface FakeGoogleCall {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeGoogleCannedResponse {
  status: number;
  headers?: Record<string, string>;
  /** A string is sent as-is; anything else is JSON-encoded. Omitted = empty body. */
  body?: unknown;
}

export interface FakeGoogleOptions {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** The service account the jwt-bearer grant accepts (its PUBLIC key verifies the assertion). */
  serviceAccount?: { clientEmail: string; publicKey: KeyObject | string };
  /** The `sub` the jwt-bearer grant accepts. */
  dexEmail?: string;
  /** What the refresh grant answers in `scope`, and what the jwt-bearer grant allows. */
  grantedScopes?: readonly string[];
  /** `expires_in` of every issued token. Default 3599. */
  expiresIn?: number;
  /** Clock in ms for the JWT `exp` check. */
  now?: () => number;
}

export interface FakeGoogle {
  transport: GoogleTransport;
  calls: FakeGoogleCall[];
  /** Every access token issued, in order. */
  tokensIssued: string[];
  /** Answer the NEXT call with this response instead of the simulated API. */
  failNext(response: FakeGoogleCannedResponse): void;
  /** The refresh token is revoked: the refresh grant now answers `invalid_grant`. */
  revokeRefreshToken(): void;
  /** Replace the granted scopes (both grants). */
  setGrantedScopes(scopes: readonly string[]): void;
}

export function fakeGoogleResponse(
  status: number,
  body: unknown = undefined,
  headers: Record<string, string> = {},
): GoogleTransportResponse {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return { status, headers: lower, text: async () => text };
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

function parseBody(body: string | undefined, contentType: string | undefined): unknown {
  if (body === undefined) return null;
  if ((contentType ?? '').startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body).entries());
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const oauthError = (status: number, error: string, description: string) => ({
  status,
  body: { error, error_description: description },
});

export function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const clientId = options.clientId ?? FAKE_GOOGLE_CLIENT_ID;
  const clientSecret = options.clientSecret ?? FAKE_GOOGLE_CLIENT_SECRET;
  const refreshToken = options.refreshToken ?? FAKE_GOOGLE_REFRESH_TOKEN;
  const dexEmail = options.dexEmail ?? FAKE_GOOGLE_DEX_EMAIL;
  const expiresIn = options.expiresIn ?? 3599;
  const now = options.now ?? DEFAULT_NOW;
  const calls: FakeGoogleCall[] = [];
  const tokensIssued: string[] = [];
  const canned: FakeGoogleCannedResponse[] = [];
  let grantedScopes: readonly string[] = [...(options.grantedScopes ?? FAKE_GOOGLE_DEFAULT_SCOPES)];
  let revoked = false;

  const issue = (): string => {
    const token = `at-${tokensIssued.length + 1}-${'a'.repeat(24)}`;
    tokensIssued.push(token);
    return token;
  };

  const refreshGrant = (form: Record<string, string>): { status: number; body: unknown } => {
    if (form.client_id !== clientId || form.client_secret !== clientSecret) {
      return oauthError(401, 'invalid_client', 'The OAuth client was not found.');
    }
    if (revoked || form.refresh_token !== refreshToken) {
      return oauthError(400, 'invalid_grant', 'Token has been expired or revoked.');
    }
    return {
      status: 200,
      body: { access_token: issue(), expires_in: expiresIn, scope: grantedScopes.join(' '), token_type: 'Bearer' },
    };
  };

  const jwtBearerGrant = (form: Record<string, string>): { status: number; body: unknown } => {
    const account = options.serviceAccount;
    const parts = typeof form.assertion === 'string' ? form.assertion.split('.') : [];
    if (account === undefined || parts.length !== 3) return oauthError(400, 'invalid_grant', 'Invalid JWT.');
    const [head, payload, signature] = parts as [string, string, string];
    const header = decodeSegment(head);
    const claims = decodeSegment(payload);
    if (header === null || claims === null || header.alg !== 'RS256' || header.typ !== 'JWT') {
      return oauthError(400, 'invalid_grant', 'Invalid JWT header.');
    }
    let valid = false;
    try {
      valid = verify('RSA-SHA256', Buffer.from(`${head}.${payload}`), account.publicKey, Buffer.from(signature, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) return oauthError(400, 'invalid_grant', 'Invalid JWT Signature.');
    const iat = claims.iat;
    const exp = claims.exp;
    if (claims.iss !== account.clientEmail) return oauthError(400, 'invalid_grant', 'Invalid JWT: iss.');
    if (claims.aud !== GOOGLE_TOKEN_URL) return oauthError(400, 'invalid_grant', 'Invalid JWT: aud.');
    if (typeof iat !== 'number' || typeof exp !== 'number' || exp - iat > 3600 || exp <= iat || exp * 1000 <= now()) {
      return oauthError(400, 'invalid_grant', 'Invalid JWT: Token must be a short-lived token.');
    }
    if (claims.sub !== dexEmail) {
      return oauthError(401, 'unauthorized_client', 'Client is unauthorized to retrieve access tokens using this method.');
    }
    const requested = typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
    if (requested.length === 0 || requested.some((scope) => !grantedScopes.includes(scope))) {
      return oauthError(401, 'unauthorized_client', 'Client is unauthorized for the requested scopes.');
    }
    return { status: 200, body: { access_token: issue(), expires_in: expiresIn, token_type: 'Bearer' } };
  };

  const simulate = (req: GoogleTransportRequest, url: URL, body: unknown): { status: number; body?: unknown } => {
    if (url.origin + url.pathname === GOOGLE_TOKEN_URL) {
      if (req.method !== 'POST') return { status: 405, body: { error: 'invalid_request' } };
      const form = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, string>;
      if (form.grant_type === 'refresh_token') return refreshGrant(form);
      if (form.grant_type === GOOGLE_JWT_BEARER_GRANT_TYPE) return jwtBearerGrant(form);
      return oauthError(400, 'unsupported_grant_type', 'Invalid grant_type.');
    }
    return { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } } };
  };

  const transport: GoogleTransport = async (req) => {
    const url = new URL(req.url);
    const headers = lowerHeaders(req.headers);
    const body = parseBody(req.body, headers['content-type']);
    calls.push({
      method: req.method,
      url: req.url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { ...headers, ...(headers.authorization !== undefined ? { authorization: '<redacted>' } : {}) },
      body,
    });
    const next = canned.shift();
    if (next) return fakeGoogleResponse(next.status, next.body, next.headers);
    const result = simulate(req, url, body);
    return fakeGoogleResponse(result.status, result.body);
  };

  return {
    transport,
    calls,
    tokensIssued,
    failNext(response) {
      canned.push(response);
    },
    revokeRefreshToken() {
      revoked = true;
    },
    setGrantedScopes(scopes) {
      grantedScopes = [...scopes];
    },
  };
}
