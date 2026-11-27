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
 * - `failNext` injects one canned response for the next call, served ahead of the simulation.
 * - `grant_type=authorization_code` (T4, the owner's one-time consent helper): the code must be one
 *   `issueAuthorizationCode` handed out and not yet redeemed (else 400 `invalid_grant`), the client id
 *   and secret must match (else 401 `invalid_client`), `redirect_uri` must equal the one the code was
 *   issued for (else 400 `redirect_uri_mismatch`) and base64url(sha256(`code_verifier`)) must equal its
 *   PKCE challenge (else 400 `invalid_grant`). The answer carries an access token, the fake's refresh
 *   token (unless the code was issued `withoutRefreshToken`) and `scope` = the code's scopes.
 *
 * T3 adds Dex's primary calendar and the Meet spaces. Every API call must carry
 * `authorization: Bearer <a token this fake issued and has not expired>` (else 401, like Google), so
 * the 401 re-mint path is testable (`expireAccessTokens()`), and a token only reaches what its scopes
 * allow (else 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`):
 * - `POST /calendar/v3/calendars/primary/events`: stores the event (an id used before, deleted or
 *   not, is 409 `duplicate`), answers the Google shape with `organizer.email` = the Dex email (or
 *   `organizerEmail`), and with a `conferenceData.createRequest` the conference is `pending` on the
 *   insert answer and on every get before the `conferenceReadyAfterGets`-th one (default 1, so the
 *   first get; 0 = ready on the insert answer), which and later ones answer `success` with a
 *   `conferenceId`, a `hangoutLink` and a Meet space (`TRUSTED` unless
 *   `defaultAccessType`). Without `conferenceDataVersion=1` the create request is ignored, like
 *   Google (so a test proves the client sends it). `conferenceFails` makes it `failure` instead. Extra Google fields (etag, htmlLink, entry points, signature, creator,
 *   extended properties...) are in every answer, so tests can prove the parser drops them.
 * - `GET|PATCH|DELETE .../events/<id>`: 404 for an unknown id, 410 once deleted. PATCH replaces
 *   each given top-level field and `attendees` wholesale (Google's array rule) and keeps the
 *   conference; DELETE answers 204.
 * - `GET /v2/spaces/<meeting code>` and `GET /v2/spaces/<id>`; `PATCH /v2/spaces/<id>` honours
 *   `updateMask` (`config.accessType` sets only that field; `*` and a meeting code are 400
 *   `INVALID_ARGUMENT`); `POST /v2/spaces` creates a space from the body's config.
 * - Any other URL answers 404 with a Google-style JSON error.
 *
 * `calls` records `{method, url, path, query, headers, body}`: the authorization value replaced by
 * `<redacted>`, a form body decoded to an object, a JSON body parsed, anything else null. Access
 * tokens are issued as `at-<n>-aaaa...` (low entropy, never a real-looking token) and listed in
 * `tokensIssued`, so tests can prove none of them leaks.
 *
 * Fixtures are built at run time from low-entropy parts (S03 plan R18). Never shipped:
 * `tsconfig.build.json` excludes `src/__tests__`.
 */
import { createHash, verify, type KeyObject } from 'node:crypto';
import type {
  GoogleTransport,
  GoogleTransportRequest,
  GoogleTransportResponse,
} from '../../integrations/google/http.js';
import {
  GOOGLE_CALENDAR_EVENTS_URL,
  GOOGLE_MEET_API_URL,
  GOOGLE_TOKEN_URL,
} from '../../integrations/google/http.js';
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
  /** The organizer the calendar answers with. Default: the Dex email. */
  organizerEmail?: string;
  /** How many event gets answer `pending` before the conference is `success`. Default 1; 0 = at once. */
  conferenceReadyAfterGets?: number;
  /** The conference create request ends in `failure`. */
  conferenceFails?: boolean;
  /** The access type of a space that Calendar creates. Default `TRUSTED`. */
  defaultAccessType?: FakeGoogleAccessType;
}

export type FakeGoogleAccessType = 'OPEN' | 'TRUSTED' | 'RESTRICTED';

export interface FakeGoogleEvent {
  id: string;
  /** The stored fields as sent (insert, then each patch merged in). */
  fields: Record<string, unknown>;
  deleted: boolean;
  /** How many GETs this event answered. */
  gets: number;
  sequence: number;
  /** Set when the insert asked for a conference (with conferenceDataVersion=1). */
  conference: { requestId: string; code: string; spaceName: string } | null;
}

export interface FakeGoogleSpace {
  name: string;
  meetingCode: string;
  accessType: string;
  entryPointAccess: string;
}

/** What the consent page "granted" for one authorization code (T4). */
export interface FakeGoogleAuthorizationCodeGrant {
  /** The `redirect_uri` the consent request carried; the exchange must send the same one. */
  redirectUri: string;
  /** The PKCE S256 `code_challenge` the consent request carried. */
  codeChallenge: string;
  /** The scopes the user granted. Default: the fake's granted scopes. */
  scopes?: readonly string[];
  /** Answer the exchange without a `refresh_token`. */
  withoutRefreshToken?: boolean;
}

export interface FakeGoogle {
  transport: GoogleTransport;
  /**
   * Hand out a one-use authorization code, as Google's consent page does on "Allow" (T4). The code
   * is low entropy (`code-<n>-cccc...`), never a real-looking one.
   */
  issueAuthorizationCode(grant: FakeGoogleAuthorizationCodeGrant): string;
  calls: FakeGoogleCall[];
  /** Every access token issued, in order. */
  tokensIssued: string[];
  /** Dex's primary calendar, by event id. */
  events: ReadonlyMap<string, FakeGoogleEvent>;
  /** The Meet spaces, by name. */
  spaces: ReadonlyMap<string, FakeGoogleSpace>;
  /** Answer the NEXT call with this response instead of the simulated API. */
  failNext(response: FakeGoogleCannedResponse): void;
  /** The refresh token is revoked: the refresh grant now answers `invalid_grant`. */
  revokeRefreshToken(): void;
  /** Replace the granted scopes (both grants). */
  setGrantedScopes(scopes: readonly string[]): void;
  /** Every access token issued so far stops working: the next API call with one answers 401. */
  expireAccessTokens(): void;
  /** Seed a Meet space directly (default `TRUSTED`, `ALL`). */
  addSpace(config?: { accessType?: FakeGoogleAccessType; entryPointAccess?: 'ALL' | 'CREATOR_APP_ONLY' }): FakeGoogleSpace;
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
  /** The access tokens that still work, with the scopes each one carries. */
  const liveTokens = new Map<string, readonly string[]>();
  const events = new Map<string, FakeGoogleEvent>();
  const spaces = new Map<string, FakeGoogleSpace>();

  const issue = (scopes: readonly string[] = grantedScopes): string => {
    const token = `at-${tokensIssued.length + 1}-${'a'.repeat(24)}`;
    tokensIssued.push(token);
    liveTokens.set(token, [...scopes]);
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
    return { status: 200, body: { access_token: issue(requested), expires_in: expiresIn, token_type: 'Bearer' } };
  };

  // ── Authorization-code grant (T4, the consent helper) ─────────────────────

  const authorizationCodes = new Map<string, FakeGoogleAuthorizationCodeGrant & { redeemed: boolean }>();
  let codeCounter = 0;

  const issueAuthorizationCode = (grant: FakeGoogleAuthorizationCodeGrant): string => {
    codeCounter += 1;
    const code = `code-${codeCounter}-${'c'.repeat(24)}`;
    authorizationCodes.set(code, { ...grant, redeemed: false });
    return code;
  };

  const authorizationCodeGrant = (form: Record<string, string>): { status: number; body: unknown } => {
    if (form.client_id !== clientId || form.client_secret !== clientSecret) {
      return oauthError(401, 'invalid_client', 'The OAuth client was not found.');
    }
    const grant = typeof form.code === 'string' ? authorizationCodes.get(form.code) : undefined;
    if (grant === undefined || grant.redeemed) return oauthError(400, 'invalid_grant', 'Malformed auth code.');
    if (form.redirect_uri !== grant.redirectUri) {
      return oauthError(400, 'redirect_uri_mismatch', 'Bad Request');
    }
    const verifier = typeof form.code_verifier === 'string' ? form.code_verifier : '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (verifier === '' || challenge !== grant.codeChallenge) {
      return oauthError(400, 'invalid_grant', 'Invalid code verifier.');
    }
    grant.redeemed = true;
    const scopes = grant.scopes ?? grantedScopes;
    const answer: Record<string, unknown> = {
      access_token: issue(scopes),
      expires_in: expiresIn,
      scope: scopes.join(' '),
      token_type: 'Bearer',
    };
    if (grant.withoutRefreshToken !== true) answer.refresh_token = refreshToken;
    return { status: 200, body: answer };
  };

  // ── Calendar (Dex's primary calendar) ─────────────────────────────────────

  const organizerEmail = options.organizerEmail ?? dexEmail;
  const readyAfterGets = options.conferenceReadyAfterGets ?? 1;
  const defaultAccessType: FakeGoogleAccessType = options.defaultAccessType ?? 'TRUSTED';
  let spaceCounter = 0;

  /** A deterministic meeting code `xxx-xxxx-xxx` for the n-th space. */
  const meetingCodeFor = (n: number): string => {
    let value = n + 26 ** 6;
    let letters = '';
    for (let i = 0; i < 10; i += 1) {
      letters = String.fromCharCode(97 + (value % 26)) + letters;
      value = Math.floor(value / 26);
    }
    return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
  };

  const newSpace = (accessType: string, entryPointAccess: string): FakeGoogleSpace => {
    spaceCounter += 1;
    const space: FakeGoogleSpace = {
      name: `spaces/fake-space-${spaceCounter}`,
      meetingCode: meetingCodeFor(spaceCounter),
      accessType,
      entryPointAccess,
    };
    spaces.set(space.name, space);
    return space;
  };

  const googleError = (status: number, statusWord: string, message: string, extra: Record<string, unknown> = {}) => ({
    status,
    body: { error: { code: status, message, status: statusWord, ...extra } },
  });
  const calendarError = (status: number, reason: string, message: string) => ({
    status,
    body: { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } },
  });

  const conferenceStatus = (event: FakeGoogleEvent): 'pending' | 'success' | 'failure' => {
    if (options.conferenceFails) return 'failure';
    return event.gets >= readyAfterGets ? 'success' : 'pending';
  };

  const eventJson = (event: FakeGoogleEvent): Record<string, unknown> => {
    const fields = event.fields;
    const out: Record<string, unknown> = {
      kind: 'calendar#event',
      etag: `"${3_000_000_000_000 + event.sequence}"`,
      id: event.id,
      status: 'confirmed',
      htmlLink: `https://www.google.com/calendar/event?eid=${event.id}`,
      summary: fields.summary,
      description: fields.description,
      creator: { email: organizerEmail, self: true },
      organizer: { email: organizerEmail, self: true, displayName: 'Dex (AI Interviewer)' },
      start: fields.start,
      end: fields.end,
      iCalUID: `${event.id}@google.com`,
      sequence: event.sequence,
      guestsCanInviteOthers: fields.guestsCanInviteOthers,
      guestsCanModify: fields.guestsCanModify,
      guestsCanSeeOtherGuests: fields.guestsCanSeeOtherGuests,
      reminders: fields.reminders,
      extendedProperties: fields.extendedProperties,
      eventType: 'default',
    };
    if (fields.location !== undefined) out.location = fields.location;
    if (Array.isArray(fields.attendees)) {
      out.attendees = (fields.attendees as Record<string, unknown>[]).map((attendee) => ({
        ...attendee,
        responseStatus: 'needsAction',
      }));
    }
    if (event.conference !== null) {
      const status = conferenceStatus(event);
      const conferenceData: Record<string, unknown> = {
        createRequest: {
          requestId: event.conference.requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
          status: { statusCode: status },
        },
      };
      if (status === 'success') {
        const link = `https://meet.google.com/${event.conference.code}`;
        conferenceData.entryPoints = [{ entryPointType: 'video', uri: link, label: `meet.google.com/${event.conference.code}` }];
        conferenceData.conferenceSolution = { key: { type: 'hangoutsMeet' }, name: 'Google Meet' };
        conferenceData.conferenceId = event.conference.code;
        conferenceData.signature = 'sig-' + 'x'.repeat(20);
        out.hangoutLink = link;
      }
      out.conferenceData = conferenceData;
    }
    return out;
  };

  const calendarEventsPath = new URL(GOOGLE_CALENDAR_EVENTS_URL).pathname;
  const EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;

  const calendar = (req: GoogleTransportRequest, url: URL, body: unknown): { status: number; body?: unknown } => {
    const query = url.searchParams;
    if (url.pathname === calendarEventsPath) {
      if (req.method !== 'POST') return calendarError(405, 'httpMethodNotAllowed', 'Method not allowed.');
      const fields = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      const id = fields.id;
      if (typeof id !== 'string' || !EVENT_ID_RE.test(id)) return calendarError(400, 'invalid', 'Invalid resource id value.');
      if (events.has(id)) return calendarError(409, 'duplicate', 'The requested identifier already exists.');
      const request = (fields.conferenceData as { createRequest?: { requestId?: unknown } } | undefined)?.createRequest;
      let conference: FakeGoogleEvent['conference'] = null;
      if (request !== undefined && query.get('conferenceDataVersion') === '1') {
        const space = newSpace(defaultAccessType, 'ALL');
        conference = { requestId: String(request.requestId), code: space.meetingCode, spaceName: space.name };
      }
      const stored = { ...fields };
      delete stored.conferenceData;
      const event: FakeGoogleEvent = { id, fields: stored, deleted: false, gets: 0, sequence: 0, conference };
      events.set(id, event);
      return { status: 200, body: eventJson(event) };
    }
    const id = url.pathname.slice(calendarEventsPath.length + 1);
    const event = events.get(id);
    if (event === undefined) return calendarError(404, 'notFound', 'Not Found');
    if (event.deleted) return calendarError(410, 'deleted', 'Resource has been deleted');
    if (req.method === 'GET') {
      event.gets += 1;
      return { status: 200, body: eventJson(event) };
    }
    if (req.method === 'PATCH') {
      const patch = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        // Google: unspecified fields are kept, and a given array REPLACES the stored one.
        if (key === 'conferenceData' || key === 'id') continue;
        event.fields[key] = value;
      }
      if ('start' in patch || 'end' in patch) event.sequence += 1;
      return { status: 200, body: eventJson(event) };
    }
    if (req.method === 'DELETE') {
      event.deleted = true;
      return { status: 204 };
    }
    return calendarError(405, 'httpMethodNotAllowed', 'Method not allowed.');
  };

  // ── Meet spaces ───────────────────────────────────────────────────────────

  const MEETING_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
  const ACCESS_TYPES = ['OPEN', 'TRUSTED', 'RESTRICTED'];
  const ENTRY_POINT_ACCESS = ['ALL', 'CREATOR_APP_ONLY'];
  const meetSpacesPath = new URL(`${GOOGLE_MEET_API_URL}spaces`).pathname;

  const spaceJson = (space: FakeGoogleSpace): Record<string, unknown> => ({
    name: space.name,
    meetingUri: `https://meet.google.com/${space.meetingCode}`,
    meetingCode: space.meetingCode,
    config: {
      accessType: space.accessType,
      entryPointAccess: space.entryPointAccess,
      moderation: 'OFF',
      attendanceReportGenerationType: 'DO_NOT_GENERATE',
    },
  });
  const invalidArgument = (message: string) => googleError(400, 'INVALID_ARGUMENT', message);
  const spaceNotFound = () => googleError(404, 'NOT_FOUND', 'Requested entity was not found.');

  const meet = (req: GoogleTransportRequest, url: URL, body: unknown): { status: number; body?: unknown } => {
    const config = ((body as { config?: unknown } | null)?.config ?? {}) as Record<string, unknown>;
    if (url.pathname === meetSpacesPath) {
      if (req.method !== 'POST') return googleError(405, 'UNIMPLEMENTED', 'Method not allowed.');
      const accessType = config.accessType ?? defaultAccessType;
      const entryPointAccess = config.entryPointAccess ?? 'ALL';
      if (!ACCESS_TYPES.includes(String(accessType)) || !ENTRY_POINT_ACCESS.includes(String(entryPointAccess))) {
        return invalidArgument('Invalid space config.');
      }
      return { status: 200, body: spaceJson(newSpace(String(accessType), String(entryPointAccess))) };
    }
    const key = url.pathname.slice(meetSpacesPath.length + 1);
    const byCode = MEETING_CODE_RE.test(key);
    if (req.method === 'GET') {
      const space = byCode ? [...spaces.values()].find((item) => item.meetingCode === key) : spaces.get(`spaces/${key}`);
      return space === undefined ? spaceNotFound() : { status: 200, body: spaceJson(space) };
    }
    if (req.method === 'PATCH') {
      // Updates need the `spaces/<id>` name; the meeting-code alias is for reads only.
      if (byCode) return invalidArgument('Space name must be in the format spaces/{space}.');
      const space = spaces.get(`spaces/${key}`);
      if (space === undefined) return spaceNotFound();
      const mask = url.searchParams.get('updateMask');
      if (mask === '*') return invalidArgument('Wildcard update masks are not allowed in this fake.');
      const paths = mask === null || mask === '' ? ['config.accessType', 'config.entryPointAccess'] : mask.split(',');
      const next = { ...space };
      for (const path of paths) {
        if (path === 'config.accessType') {
          if (config.accessType === undefined && mask === null) continue;
          if (!ACCESS_TYPES.includes(String(config.accessType))) return invalidArgument('Invalid access type.');
          next.accessType = String(config.accessType);
        } else if (path === 'config.entryPointAccess') {
          if (config.entryPointAccess === undefined && mask === null) continue;
          if (!ENTRY_POINT_ACCESS.includes(String(config.entryPointAccess))) return invalidArgument('Invalid entry point access.');
          next.entryPointAccess = String(config.entryPointAccess);
        } else {
          return invalidArgument('Unknown update mask path.');
        }
      }
      Object.assign(space, next);
      return { status: 200, body: spaceJson(space) };
    }
    return googleError(405, 'UNIMPLEMENTED', 'Method not allowed.');
  };

  // ── Routing ───────────────────────────────────────────────────────────────

  const calendarOrigin = new URL(GOOGLE_CALENDAR_EVENTS_URL).origin;
  const meetOrigin = new URL(GOOGLE_MEET_API_URL).origin;

  /** The scopes an API request needs (any one of them). */
  const neededScopes = (req: GoogleTransportRequest, url: URL): readonly string[] => {
    if (url.origin === calendarOrigin) return [GOOGLE_SCOPES.calendarEventsOwned];
    if (req.method === 'POST') return [GOOGLE_SCOPES.meetSpaceCreated];
    return [GOOGLE_SCOPES.meetSpaceSettings, GOOGLE_SCOPES.meetSpaceCreated];
  };

  const simulate = (req: GoogleTransportRequest, url: URL, body: unknown): { status: number; body?: unknown } => {
    if (url.origin + url.pathname === GOOGLE_TOKEN_URL) {
      if (req.method !== 'POST') return { status: 405, body: { error: 'invalid_request' } };
      const form = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, string>;
      if (form.grant_type === 'refresh_token') return refreshGrant(form);
      if (form.grant_type === GOOGLE_JWT_BEARER_GRANT_TYPE) return jwtBearerGrant(form);
      if (form.grant_type === 'authorization_code') return authorizationCodeGrant(form);
      return oauthError(400, 'unsupported_grant_type', 'Invalid grant_type.');
    }
    const isCalendar = url.origin === calendarOrigin && url.pathname.startsWith(calendarEventsPath);
    const isMeet = url.origin === meetOrigin && url.pathname.startsWith(meetSpacesPath);
    if (!isCalendar && !isMeet) return spaceNotFound();

    const authorization = lowerHeaders(req.headers).authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const scopes = liveTokens.get(bearer);
    if (scopes === undefined) {
      return googleError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    }
    if (!neededScopes(req, url).some((scope) => scopes.includes(scope))) {
      return googleError(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.', {
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
      });
    }
    return isCalendar ? calendar(req, url, body) : meet(req, url, body);
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
    issueAuthorizationCode,
    calls,
    tokensIssued,
    events,
    spaces,
    failNext(response) {
      canned.push(response);
    },
    revokeRefreshToken() {
      revoked = true;
    },
    setGrantedScopes(scopes) {
      grantedScopes = [...scopes];
    },
    expireAccessTokens() {
      liveTokens.clear();
    },
    addSpace(config = {}) {
      return newSpace(config.accessType ?? defaultAccessType, config.entryPointAccess ?? 'ALL');
    },
  };
}
