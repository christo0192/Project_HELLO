/**
 * google/meet.ts — the Google Meet REST API v2 spaces of Dex's meetings (M035 S03, contract §7.1).
 *
 * OUTBOUND BOUNDARY, DARK. Nothing builds this at runtime yet; `createR1MeetGoogle` (client.ts)
 * does, and S05/S06 call that only when the public booking configuration is `on`. It reads NO
 * environment.
 *
 * Why it exists (owner decision 2026-11-26, contract §7.6): the default bot is the GUEST bot, which
 * is not the host and cannot admit anyone, and the organizer (Dex) never joins. So every meeting must
 * be OPEN: anyone with the link joins without knocking. S05 reads the space of each booking and makes
 * it OPEN, then reads it back before it arms the bot.
 *
 * What it guarantees (S03 plan R5, R8, R16):
 * - `getSpace` takes a meeting code (`abc-defg-hij`) or a space name (`spaces/<id>`); 404 = null.
 * - `makeSpaceOpen` takes ONLY the `spaces/<id>` form (Google updates need the name, not the code)
 *   and sends exactly `PATCH .../v2/spaces/<id>?updateMask=config.accessType` with the body
 *   `{"config":{"accessType":"OPEN"}}`. Never the `*` mask, which would clear every field not sent
 *   (the shared HTTP core cannot even send one: its query values are plain words).
 * - `createOpenSpace` exists only in space mode (`R1_MEET_GOOGLE_MEET_MODE=space`, which also needs
 *   the `meetings.space.created` scope); in calendar mode it is refused with zero network.
 * - Every input is validated BEFORE a token is minted: a refused call makes ZERO transport calls of
 *   any kind and throws `GoogleError('invalid_request')`.
 * - The parsed space is closed: name (required, and equal to the one asked for), meeting code, the
 *   canonical meeting link, access type and entry-point access. Everything else is dropped.
 * - One attempt per call (plus the single re-mint on a 401), a deadline, a body cap and one
 *   metadata-only log record per call. Space names, codes and links never reach a log or an error.
 */

import { GOOGLE_MEET_CODE_RE, normalizeGoogleMeetUrl } from '../google-meet/url.js';
import { GoogleError, type GoogleOperation } from './errors.js';
import {
  GOOGLE_MEET_API_URL,
  emitGoogleLog,
  sendAuthorizedGoogleRequest,
  type GoogleAccessTokenProvider,
  type GoogleClientLogger,
  type GoogleSendOptions,
  type GoogleSendResult,
  type GoogleTransport,
} from './http.js';

// ── Public shapes (contract §7.1) ───────────────────────────────────────────

export interface GoogleMeetSpace {
  name: string;
  meetingCode: string | null;
  meetingUri: string | null;
  accessType: 'OPEN' | 'TRUSTED' | 'RESTRICTED' | null;
  entryPointAccess: 'ALL' | 'CREATOR_APP_ONLY' | null;
}

export interface GoogleMeetClient {
  /** A meeting code or `spaces/<id>`; null on 404. */
  getSpace(nameOrMeetingCode: string): Promise<GoogleMeetSpace | null>;
  /** `spaces/<id>` only: PATCH ?updateMask=config.accessType, never updateMask=*. */
  makeSpaceOpen(name: string): Promise<GoogleMeetSpace>;
  /** Space mode only: a new OPEN space with every entry point. */
  createOpenSpace(): Promise<GoogleMeetSpace>;
}

export type GoogleMeetMode = 'calendar' | 'space';

export interface GoogleMeetClientOptions {
  /** Dex's token source (`createR1MeetGoogle` shares one with the Calendar client). */
  tokenSource: GoogleAccessTokenProvider;
  /** `calendar` (default design: Calendar makes the Meet) or `space` (the Meet API makes it). */
  meetMode: GoogleMeetMode;
  /** Test seam: fully replaces the network. */
  transport?: GoogleTransport;
  /** Metadata-only logger: one record per public call. */
  logger?: GoogleClientLogger;
  /** Per-request deadline (default 10 s, clamped 1..30 s). */
  timeoutMs?: number;
  /** Response cap (default 512 KiB, clamped 1 KiB..4 MiB). */
  maxResponseBytes?: number;
}

// ── Rules (R8) ──────────────────────────────────────────────────────────────

/** A Meet space resource name. */
export const GOOGLE_MEET_SPACE_NAME_RE = /^spaces\/[A-Za-z0-9_-]{1,128}$/;
/** The only update mask this client ever sends. */
export const GOOGLE_MEET_OPEN_UPDATE_MASK = 'config.accessType';

const ACCESS_TYPES: ReadonlySet<string> = new Set(['OPEN', 'TRUSTED', 'RESTRICTED']);
const ENTRY_POINT_ACCESS: ReadonlySet<string> = new Set(['ALL', 'CREATOR_APP_ONLY']);

const OPEN_PATCH_BODY = JSON.stringify({ config: { accessType: 'OPEN' } });
const OPEN_CREATE_BODY = JSON.stringify({ config: { accessType: 'OPEN', entryPointAccess: 'ALL' } });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isSpaceName = (raw: unknown): raw is string => typeof raw === 'string' && GOOGLE_MEET_SPACE_NAME_RE.test(raw);
const isMeetingCode = (raw: unknown): raw is string => typeof raw === 'string' && GOOGLE_MEET_CODE_RE.test(raw);

/** What a parsed space must match: the name asked for, or the meeting code asked for. */
type SpaceExpectation = { name: string } | { meetingCode: string } | null;

/**
 * The closed space of contract §7.1 from a 2xx body. `name` is required (and must equal the name
 * asked for; when asked by meeting code, a meeting code in the answer must equal it), else
 * `malformed_response`; every other field is null when missing or not one of its known values.
 */
function parseSpace(operation: GoogleOperation, expected: SpaceExpectation, result: GoogleSendResult): GoogleMeetSpace {
  const malformed = () => new GoogleError('malformed_response', { operation, httpStatus: result.status });
  const json = result.json;
  if (!isPlainObject(json) || !isSpaceName(json.name)) throw malformed();
  const meetingCode = isMeetingCode(json.meetingCode) ? json.meetingCode : null;
  if (expected !== null && 'name' in expected && json.name !== expected.name) throw malformed();
  if (expected !== null && 'meetingCode' in expected && meetingCode !== null && meetingCode !== expected.meetingCode) {
    throw malformed();
  }
  const config = isPlainObject(json.config) ? json.config : {};
  const accessType = typeof config.accessType === 'string' && ACCESS_TYPES.has(config.accessType) ? config.accessType : null;
  const entryPointAccess =
    typeof config.entryPointAccess === 'string' && ENTRY_POINT_ACCESS.has(config.entryPointAccess)
      ? config.entryPointAccess
      : null;
  return Object.freeze({
    name: json.name,
    meetingCode,
    meetingUri: normalizeGoogleMeetUrl(json.meetingUri),
    accessType: accessType as GoogleMeetSpace['accessType'],
    entryPointAccess: entryPointAccess as GoogleMeetSpace['entryPointAccess'],
  });
}

// ── Client ──────────────────────────────────────────────────────────────────

class GoogleMeetHttpClient implements GoogleMeetClient {
  readonly #tokens: GoogleAccessTokenProvider;
  readonly #meetMode: GoogleMeetMode;
  readonly #send: GoogleSendOptions;

  constructor(o: GoogleMeetClientOptions) {
    const refuse = () => new GoogleError('invalid_request');
    if (!isPlainObject(o)) throw refuse();
    const tokens = o.tokenSource;
    if (
      typeof tokens !== 'object' ||
      tokens === null ||
      typeof tokens.accessToken !== 'function' ||
      typeof tokens.invalidate !== 'function'
    ) {
      throw refuse();
    }
    if (o.meetMode !== 'calendar' && o.meetMode !== 'space') throw refuse();
    if (o.transport !== undefined && typeof o.transport !== 'function') throw refuse();
    if (o.logger !== undefined && (o.logger === null || typeof o.logger.event !== 'function')) throw refuse();
    this.#tokens = tokens;
    this.#meetMode = o.meetMode;
    const send: GoogleSendOptions = {};
    if (o.transport !== undefined) send.transport = o.transport;
    if (o.logger !== undefined) send.logger = o.logger;
    if (o.timeoutMs !== undefined) send.timeoutMs = o.timeoutMs;
    if (o.maxResponseBytes !== undefined) send.maxResponseBytes = o.maxResponseBytes;
    this.#send = send;
  }

  /** Refused before any token or network: one failure record, zero calls of any kind. */
  #refuse(operation: GoogleOperation): Promise<never> {
    const refusal = new GoogleError('invalid_request', { operation });
    emitGoogleLog(this.#send.logger, { operation, startedAt: Date.now(), error: refusal });
    return Promise.reject(refusal);
  }

  async getSpace(nameOrMeetingCode: string): Promise<GoogleMeetSpace | null> {
    const operation: GoogleOperation = 'meet.get';
    let url: string;
    let expected: SpaceExpectation;
    if (isMeetingCode(nameOrMeetingCode)) {
      url = `${GOOGLE_MEET_API_URL}spaces/${nameOrMeetingCode}`;
      expected = { meetingCode: nameOrMeetingCode };
    } else if (isSpaceName(nameOrMeetingCode)) {
      url = `${GOOGLE_MEET_API_URL}${nameOrMeetingCode}`;
      expected = { name: nameOrMeetingCode };
    } else {
      return this.#refuse(operation);
    }
    return sendAuthorizedGoogleRequest<GoogleMeetSpace | null>(
      { operation, method: 'GET', url },
      this.#tokens,
      this.#send,
      { parse: (result) => parseSpace(operation, expected, result), onNotFound: () => null },
    );
  }

  async makeSpaceOpen(name: string): Promise<GoogleMeetSpace> {
    const operation: GoogleOperation = 'meet.patch';
    // A meeting code is refused on purpose: Google applies updates to the `spaces/<id>` name only.
    if (!isSpaceName(name)) return this.#refuse(operation);
    return sendAuthorizedGoogleRequest(
      {
        operation,
        method: 'PATCH',
        url: `${GOOGLE_MEET_API_URL}${name}?updateMask=${GOOGLE_MEET_OPEN_UPDATE_MASK}`,
        body: OPEN_PATCH_BODY,
      },
      this.#tokens,
      this.#send,
      { parse: (result) => parseSpace(operation, { name }, result) },
    );
  }

  async createOpenSpace(): Promise<GoogleMeetSpace> {
    const operation: GoogleOperation = 'meet.create';
    if (this.#meetMode !== 'space') return this.#refuse(operation);
    return sendAuthorizedGoogleRequest(
      { operation, method: 'POST', url: `${GOOGLE_MEET_API_URL}spaces`, body: OPEN_CREATE_BODY },
      this.#tokens,
      this.#send,
      { parse: (result) => parseSpace(operation, null, result) },
    );
  }
}

/**
 * The Meet client for Dex's meetings. Throws `GoogleError('invalid_request')` synchronously, with
 * zero network, when the token source, the Meet mode or a seam is not usable.
 */
export function createGoogleMeetClient(o: GoogleMeetClientOptions): GoogleMeetClient {
  return new GoogleMeetHttpClient(o);
}
