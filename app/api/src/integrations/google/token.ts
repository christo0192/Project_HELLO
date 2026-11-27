/**
 * google/token.ts — access-token sources for Dex's Google account (M035 S03, contract §7.1).
 *
 * OUTBOUND BOUNDARY, DARK. Nothing builds a token source at runtime yet; `createR1MeetGoogle`
 * (S03 T3) picks one by `settings.authMode`, and S05/S06 build that only when the public booking
 * configuration is `on`. It reads NO environment.
 *
 * Two sources, one cache rule (S03 plan R3, R5, R9):
 * - DEFAULT `oauth_refresh` (owner decision 2026-11-26): the Dex user's OAuth client and refresh
 *   token, sent as the refresh grant with the client id and secret in the form body and no scope
 *   parameter (Google grants what the refresh token was minted with). Dex is a normal non-admin
 *   user in the company Workspace, so no service account may impersonate anyone there.
 * - `service_account` (a dedicated Dex Workspace only): an RS256 JWT signed with `node:crypto`
 *   (`kid`, `iss` = the service account, `sub` = Dex, `scope`, `aud` = the token URL,
 *   `exp = iat + 3600`), exchanged with the jwt-bearer grant. The PEM is parsed lazily on the first
 *   `accessToken()`; a key that does not parse as RSA rejects `setup_forbidden` with zero requests.
 *
 * Cache: a token is kept until `now + expires_in - 60 s` (a token valid for 60 s or less is used
 * once, never cached). Concurrent `accessToken()` calls share one in-flight mint. After the token
 * endpoint answered `auth_revoked` (`invalid_grant`) or `setup_forbidden`, the source rejects with an
 * equal error for 60 s WITHOUT a network call, then tries once more: a dead grant is never retried
 * in a loop. `invalidate()` drops the cached token only (the 401 re-mint path), not that refusal.
 *
 * SECURITY: the client secret, the refresh token, the private key, the JWT assertion and every
 * access token live only in ES private fields or local variables; none is ever logged, put into an
 * error or visible through `Object.keys`, a spread, `JSON.stringify` or `util.inspect`. Logging is
 * one metadata-only record per mint attempt (`token.refresh` / `token.jwt_bearer`); a cache hit or
 * a refusal served from the 60 s window makes no request and logs nothing. The record goes to the
 * logger of the `accessToken({ logger })` call that started the mint when one is given (the
 * process-wide source of `getR1MeetGoogle` is built without a logger and serves every caller), else to
 * the logger the source was built with.
 */

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { GoogleError, type GoogleOperation } from './errors.js';
import {
  GOOGLE_TOKEN_URL,
  emitGoogleLog,
  sendGoogleRequest,
  type GoogleClientLogger,
  type GoogleSendOptions,
  type GoogleSendResult,
  type GoogleTransport,
} from './http.js';

export { GOOGLE_TOKEN_URL } from './http.js';

/** The three OAuth scopes the Dex client may use (contract §7.1). */
export const GOOGLE_SCOPES = Object.freeze({
  calendarEventsOwned: 'https://www.googleapis.com/auth/calendar.events.owned',
  meetSpaceSettings: 'https://www.googleapis.com/auth/meetings.space.settings',
  /** Space mode only (`R1_MEET_GOOGLE_MEET_MODE=space`). */
  meetSpaceCreated: 'https://www.googleapis.com/auth/meetings.space.created',
} as const);

export type GoogleScope = (typeof GOOGLE_SCOPES)[keyof typeof GOOGLE_SCOPES];

const SCOPE_VALUES: readonly string[] = Object.freeze(Object.values(GOOGLE_SCOPES));

/** The consent screen the owner-run helper opens (S03 T4). Holds no secret. */
export const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export const GOOGLE_JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** A cached token is dropped this long before Google says it expires. */
export const GOOGLE_TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** How long an `auth_revoked` / `setup_forbidden` answer is replayed without a request. */
export const GOOGLE_TOKEN_REFUSAL_WINDOW_MS = 60_000;
/** The DWD assertion lifetime: `exp = iat + 3600` (Google's maximum). */
export const GOOGLE_JWT_LIFETIME_SECONDS = 3600;

/** Per-call options of `accessToken`. */
export interface GoogleAccessTokenOptions {
  /**
   * Receives the record of a mint this call starts (a cache hit, a joined in-flight mint and a
   * refusal-window replay log nothing), instead of the logger the source was built with.
   */
  logger?: GoogleClientLogger;
}

export interface GoogleTokenSource {
  /** A Bearer access token for the configured scopes; cached, single-flight. */
  accessToken(options?: GoogleAccessTokenOptions): Promise<string>;
  /** Drop the cached token (after a 401), so the next `accessToken()` mints a new one. */
  invalidate(): void;
}

interface GoogleTokenSourceCommonOptions {
  /** Values of `GOOGLE_SCOPES`, non-empty, unique. */
  scopes: readonly string[];
  /** Test seam: fully replaces the network. */
  transport?: GoogleTransport;
  /** Clock in ms (cache expiry, refusal window, JWT `iat`). Default `Date.now`. */
  now?: () => number;
  /** Metadata-only logger; default silent. */
  logger?: GoogleClientLogger;
  /** Per-mint deadline (default 10 s, clamped 1..30 s). */
  timeoutMs?: number;
  /** Token response cap (default 512 KiB, clamped 1 KiB..4 MiB). */
  maxResponseBytes?: number;
}

export interface GoogleOAuthRefreshTokenSourceOptions extends GoogleTokenSourceCommonOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GoogleServiceAccountKey {
  clientEmail: string;
  privateKeyId: string;
  /** PEM text of the service account's RSA private key. */
  privateKey: string;
}

export interface GoogleDwdTokenSourceOptions extends GoogleTokenSourceCommonOptions {
  key: GoogleServiceAccountKey;
  /** The user the service account acts as: Dex's email. */
  subject: string;
}

// ── Validation ──────────────────────────────────────────────────────────────

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,173}\.apps\.googleusercontent\.com$/;
const MAX_CLIENT_ID_LENGTH = 200;
const CLIENT_SECRET_RE = /^[\x21-\x7e]{1,200}$/;
const REFRESH_TOKEN_RE = /^[\x21-\x7e]{1,512}$/;
const PRIVATE_KEY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PRIVATE_KEY_LENGTH = 16 * 1024;
const MAX_EMAIL_LENGTH = 254;
/** Printable ASCII without whitespace and without the address-list punctuation `<>(),;:"\`. */
const EMAIL_CHARS_RE = /^[\x21-\x7e]+$/;
const EMAIL_FORBIDDEN_RE = /[<>(),;:"\\]/;

/** An access token as Google sends it: 1..4096 printable ASCII, no whitespace. */
const ACCESS_TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;
const MAX_EXPIRES_IN_SECONDS = 86_400;

function isAccountEmail(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length < 3 || raw.length > MAX_EMAIL_LENGTH) return false;
  if (!EMAIL_CHARS_RE.test(raw) || EMAIL_FORBIDDEN_RE.test(raw)) return false;
  const parts = raw.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || domain.length < 3) return false;
  const dot = domain.indexOf('.');
  return dot > 0 && !domain.endsWith('.');
}

function validateScopes(raw: unknown, refuse: () => GoogleError): readonly GoogleScope[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SCOPE_VALUES.length) throw refuse();
  const out: GoogleScope[] = [];
  for (const scope of raw) {
    if (typeof scope !== 'string' || !SCOPE_VALUES.includes(scope) || out.includes(scope as GoogleScope)) throw refuse();
    out.push(scope as GoogleScope);
  }
  return Object.freeze(out);
}

interface CommonSettings {
  scopes: readonly GoogleScope[];
  now: () => number;
  logger: GoogleClientLogger | undefined;
  send: GoogleSendOptions;
}

function validateCommon(o: GoogleTokenSourceCommonOptions, refuse: () => GoogleError): CommonSettings {
  const scopes = validateScopes(o.scopes, refuse);
  if (o.transport !== undefined && typeof o.transport !== 'function') throw refuse();
  if (o.now !== undefined && typeof o.now !== 'function') throw refuse();
  if (o.logger !== undefined && (o.logger === null || typeof o.logger.event !== 'function')) throw refuse();
  const clock = o.now ?? Date.now;
  const now = () => {
    const value = clock();
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  };
  const send: GoogleSendOptions = {};
  if (o.transport !== undefined) send.transport = o.transport;
  if (o.timeoutMs !== undefined) send.timeoutMs = o.timeoutMs;
  if (o.maxResponseBytes !== undefined) send.maxResponseBytes = o.maxResponseBytes;
  if (o.logger !== undefined) send.logger = o.logger;
  return { scopes, now, logger: o.logger, send };
}

/** The logger of one mint: the caller's when given, else the source's own. */
function mintLogger(settings: CommonSettings, options: GoogleAccessTokenOptions | undefined): GoogleClientLogger | undefined {
  const perCall = typeof options === 'object' && options !== null ? options.logger : undefined;
  return perCall ?? settings.logger;
}

/** The send options of one mint, carrying exactly that mint's logger. */
function mintSendOptions(settings: CommonSettings, logger: GoogleClientLogger | undefined): GoogleSendOptions {
  const send: GoogleSendOptions = { ...settings.send };
  delete send.logger;
  if (logger !== undefined) send.logger = logger;
  return send;
}

// ── Token response ──────────────────────────────────────────────────────────

interface MintedToken {
  token: string;
  expiresInSeconds: number;
}

/**
 * The closed token response (R5): `access_token` (1..4096 printable ASCII), `expires_in` (integer
 * 1..86400), `token_type` Bearer (any case). A present `scope` must hold every scope the source was
 * built with (granular consent can drop one): else `setup_forbidden`. An absent `scope` is accepted.
 */
function parseTokenResponse(
  operation: GoogleOperation,
  result: GoogleSendResult,
  scopes: readonly GoogleScope[],
): MintedToken {
  const malformed = () => new GoogleError('malformed_response', { operation, httpStatus: result.status });
  const json = result.json;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw malformed();
  const body = json as Record<string, unknown>;
  const token = body.access_token;
  if (typeof token !== 'string' || !ACCESS_TOKEN_RE.test(token)) throw malformed();
  const expiresIn = body.expires_in;
  if (
    typeof expiresIn !== 'number' ||
    !Number.isInteger(expiresIn) ||
    expiresIn < 1 ||
    expiresIn > MAX_EXPIRES_IN_SECONDS
  ) {
    throw malformed();
  }
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') throw malformed();
  if (body.scope !== undefined) {
    if (typeof body.scope !== 'string') throw malformed();
    const granted = new Set(body.scope.split(/\s+/).filter((item) => item !== ''));
    for (const scope of scopes) {
      if (!granted.has(scope)) throw new GoogleError('setup_forbidden', { operation, httpStatus: result.status });
    }
  }
  return { token, expiresInSeconds: expiresIn };
}

const FORM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/x-www-form-urlencoded',
  accept: 'application/json',
});

// ── Cache ───────────────────────────────────────────────────────────────────

interface Refusal {
  code: 'auth_revoked' | 'setup_forbidden';
  operation: GoogleOperation | null;
  httpStatus: number | null;
  until: number;
}

/** The shared cache rule of both sources. The current token lives in a private field. */
class TokenCache {
  #token: string | null = null;
  #expiresAt = 0;
  #inflight: Promise<string> | null = null;
  #refusal: Refusal | null = null;
  readonly #now: () => number;
  readonly #operation: GoogleOperation;

  constructor(now: () => number, operation: GoogleOperation) {
    this.#now = now;
    this.#operation = operation;
  }

  get(mint: () => Promise<MintedToken>): Promise<string> {
    const startedAt = this.#now();
    if (this.#token !== null && startedAt < this.#expiresAt) return Promise.resolve(this.#token);
    const refusal = this.#refusal;
    if (refusal !== null && startedAt < refusal.until) {
      return Promise.reject(
        new GoogleError(refusal.code, { operation: refusal.operation, httpStatus: refusal.httpStatus }),
      );
    }
    if (this.#inflight !== null) return this.#inflight;

    const flight = (async () => {
      try {
        const minted = await mint();
        this.#refusal = null;
        if (minted.expiresInSeconds * 1000 > GOOGLE_TOKEN_EXPIRY_MARGIN_MS) {
          this.#token = minted.token;
          this.#expiresAt = startedAt + minted.expiresInSeconds * 1000 - GOOGLE_TOKEN_EXPIRY_MARGIN_MS;
        } else {
          // Valid for a minute or less: used once, never cached.
          this.#token = null;
          this.#expiresAt = 0;
        }
        return minted.token;
      } catch (error) {
        const failure =
          error instanceof GoogleError ? error : new GoogleError('malformed_response', { operation: this.#operation });
        if (failure.code === 'auth_revoked' || failure.code === 'setup_forbidden') {
          this.#refusal = {
            code: failure.code,
            operation: failure.operation,
            httpStatus: failure.httpStatus,
            until: this.#now() + GOOGLE_TOKEN_REFUSAL_WINDOW_MS,
          };
        }
        throw failure;
      } finally {
        this.#inflight = null;
      }
    })();
    this.#inflight = flight;
    return flight;
  }

  invalidate(): void {
    this.#token = null;
    this.#expiresAt = 0;
  }
}

// ── OAuth refresh token (DEFAULT) ───────────────────────────────────────────

class GoogleOAuthRefreshTokenSource implements GoogleTokenSource {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #refreshToken: string;
  readonly #settings: CommonSettings;
  readonly #cache: TokenCache;

  constructor(o: GoogleOAuthRefreshTokenSourceOptions) {
    const refuse = () => new GoogleError('invalid_request', { operation: 'token.refresh' });
    if (typeof o !== 'object' || o === null) throw refuse();
    if (typeof o.clientId !== 'string' || o.clientId.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_RE.test(o.clientId)) {
      throw refuse();
    }
    if (typeof o.clientSecret !== 'string' || !CLIENT_SECRET_RE.test(o.clientSecret)) throw refuse();
    if (typeof o.refreshToken !== 'string' || !REFRESH_TOKEN_RE.test(o.refreshToken)) throw refuse();
    this.#settings = validateCommon(o, refuse);
    this.#clientId = o.clientId;
    this.#clientSecret = o.clientSecret;
    this.#refreshToken = o.refreshToken;
    this.#cache = new TokenCache(this.#settings.now, 'token.refresh');
  }

  accessToken(options?: GoogleAccessTokenOptions): Promise<string> {
    const logger = mintLogger(this.#settings, options);
    return this.#cache.get(() => this.#mint(logger));
  }

  invalidate(): void {
    this.#cache.invalidate();
  }

  async #mint(logger: GoogleClientLogger | undefined): Promise<MintedToken> {
    const operation: GoogleOperation = 'token.refresh';
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      refresh_token: this.#refreshToken,
    }).toString();
    return sendGoogleRequest(
      { operation, context: 'token', method: 'POST', url: GOOGLE_TOKEN_URL, headers: FORM_HEADERS, body },
      mintSendOptions(this.#settings, logger),
      (result) => parseTokenResponse(operation, result, this.#settings.scopes),
    );
  }
}

/**
 * DEFAULT mode: the Dex user's refresh token. Throws `GoogleError('invalid_request')` synchronously,
 * with zero network, on a malformed client id, secret, refresh token, scope list or seam.
 */
export function createGoogleOAuthRefreshTokenSource(o: GoogleOAuthRefreshTokenSourceOptions): GoogleTokenSource {
  return new GoogleOAuthRefreshTokenSource(o);
}

// ── Service account + domain-wide delegation (dedicated Dex Workspace only) ─

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

class GoogleDwdTokenSource implements GoogleTokenSource {
  readonly #clientEmail: string;
  readonly #privateKeyId: string;
  readonly #privateKeyPem: string;
  readonly #subject: string;
  readonly #settings: CommonSettings;
  readonly #cache: TokenCache;
  /** The parsed key once `accessToken()` ran; `false` when the PEM did not parse as RSA. */
  #signingKey: KeyObject | false | null = null;

  constructor(o: GoogleDwdTokenSourceOptions) {
    const refuse = () => new GoogleError('invalid_request', { operation: 'token.jwt_bearer' });
    if (typeof o !== 'object' || o === null) throw refuse();
    const key = o.key;
    if (typeof key !== 'object' || key === null) throw refuse();
    if (!isAccountEmail(key.clientEmail)) throw refuse();
    if (typeof key.privateKeyId !== 'string' || !PRIVATE_KEY_ID_RE.test(key.privateKeyId)) throw refuse();
    if (typeof key.privateKey !== 'string' || key.privateKey.length === 0 || key.privateKey.length > MAX_PRIVATE_KEY_LENGTH) {
      throw refuse();
    }
    if (!isAccountEmail(o.subject)) throw refuse();
    this.#settings = validateCommon(o, refuse);
    this.#clientEmail = key.clientEmail;
    this.#privateKeyId = key.privateKeyId;
    this.#privateKeyPem = key.privateKey;
    this.#subject = o.subject;
    this.#cache = new TokenCache(this.#settings.now, 'token.jwt_bearer');
  }

  accessToken(options?: GoogleAccessTokenOptions): Promise<string> {
    const logger = mintLogger(this.#settings, options);
    return this.#cache.get(() => this.#mint(logger));
  }

  invalidate(): void {
    this.#cache.invalidate();
  }

  /** Parse the PEM once; a key that is not an RSA private key is a setup error. */
  #key(): KeyObject | null {
    if (this.#signingKey === null) {
      try {
        const parsed = createPrivateKey({ key: this.#privateKeyPem, format: 'pem' });
        this.#signingKey = parsed.asymmetricKeyType === 'rsa' ? parsed : false;
      } catch {
        this.#signingKey = false;
      }
    }
    return this.#signingKey === false ? null : this.#signingKey;
  }

  async #mint(logger: GoogleClientLogger | undefined): Promise<MintedToken> {
    const operation: GoogleOperation = 'token.jwt_bearer';
    const startedAt = Date.now();
    const localFailure = () => {
      const error = new GoogleError('setup_forbidden', { operation });
      emitGoogleLog(logger, { operation, startedAt, error });
      return error;
    };
    const key = this.#key();
    if (key === null) throw localFailure();

    const iat = Math.floor(this.#settings.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.#privateKeyId }));
    const claims = b64url(
      JSON.stringify({
        iss: this.#clientEmail,
        sub: this.#subject,
        scope: this.#settings.scopes.join(' '),
        aud: GOOGLE_TOKEN_URL,
        iat,
        exp: iat + GOOGLE_JWT_LIFETIME_SECONDS,
      }),
    );
    const signingInput = `${header}.${claims}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
    } catch {
      throw localFailure();
    }
    const body = new URLSearchParams({
      grant_type: GOOGLE_JWT_BEARER_GRANT_TYPE,
      assertion: `${signingInput}.${signature}`,
    }).toString();
    return sendGoogleRequest(
      { operation, context: 'token', method: 'POST', url: GOOGLE_TOKEN_URL, headers: FORM_HEADERS, body },
      mintSendOptions(this.#settings, logger),
      (result) => parseTokenResponse(operation, result, this.#settings.scopes),
    );
  }
}

/**
 * Alternative mode (a dedicated Dex Workspace only): a service account with domain-wide delegation
 * acting as `subject` (Dex). Throws `GoogleError('invalid_request')` synchronously, with zero network,
 * on a malformed key field, subject, scope list or seam. The PEM itself is parsed on first use.
 */
export function createGoogleDwdTokenSource(o: GoogleDwdTokenSourceOptions): GoogleTokenSource {
  return new GoogleDwdTokenSource(o);
}
