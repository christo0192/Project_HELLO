/**
 * google/client.ts — the Google client for Dex, as R1-over-Meet public booking uses it (M035 S03,
 * contract §7.1).
 *
 * OUTBOUND BOUNDARY, DARK. Nothing imports this at runtime yet; S05/S06 build it only when
 * `getR1MeetPublicConfig()` is `on` (or, for the drain, from `getR1MeetPublicDrainConfig()`). It
 * reads NO environment: the settings come from lib/r1/meet/config.ts, the only reader of the Meet
 * variables (a type-only import below, erased at runtime).
 *
 * What it does (S03 plan R9, R16):
 * - Picks the token source by `settings.authMode`:
 *   - `oauth_refresh` (DEFAULT, owner decision 2026-11-26): the Dex user's OAuth client and refresh
 *     token. Dex is a normal non-admin user in the company Workspace, so nothing impersonates anyone.
 *   - `service_account`: a service account with domain-wide delegation acting as Dex, for a
 *     dedicated Dex Workspace ONLY (never the company Workspace, where it could act as any employee).
 * - The secrets are read from the settings by property name: they are NON-ENUMERABLE there (a spread
 *   or `JSON.stringify` of the settings drops them, and then the token source refuses to build).
 * - Scopes: `calendar.events.owned` + `meetings.space.settings` in calendar mode, plus
 *   `meetings.space.created` in space mode, for BOTH auth modes. The refresh grant sends no scope (it
 *   gets what the refresh token was granted); its answer must list every one, else `setup_forbidden`.
 * - ONE token source is shared by the Calendar and the Meet clients.
 * - The token cache and the 60 s refusal window live in the token source. The API therefore uses
 *   `getR1MeetGoogle` (S05/S06 MUST; fence (g) in r1-meet-dark.test.ts refuses the other factories in
 *   runtime code): ONE process-wide token source per credential set and Meet mode, keyed on neither
 *   the caller's logger nor its bounds, so every request and job of the process shares one cached
 *   token, and a dead grant costs at most one token-endpoint call (and one
 *   `r1_meet_public_google_auth_failed` alert) a minute per process, however many bookings or jobs
 *   arrive and whatever logger each passes. `createR1MeetGoogle` builds a NEW cache on every call:
 *   for the owner's scripts and tests only.
 * - Construction makes no network call and mints no token; a bad setting throws
 *   `GoogleError('invalid_request')` synchronously.
 */

import { createHash } from 'node:crypto';
import type { R1MeetGoogleSettings } from '../../lib/r1/meet/config.js';
import { createGoogleCalendarClient, type GoogleCalendarClient } from './calendar.js';
import { GoogleError } from './errors.js';
import type { GoogleClientLogger, GoogleTransport } from './http.js';
import { createGoogleMeetClient, type GoogleMeetClient, type GoogleMeetMode } from './meet.js';
import {
  GOOGLE_SCOPES,
  createGoogleDwdTokenSource,
  createGoogleOAuthRefreshTokenSource,
  type GoogleScope,
  type GoogleTokenSource,
} from './token.js';

export interface R1MeetGoogleOptions {
  /** `getR1MeetPublicConfig().google` (or the drain config's): the secrets are non-enumerable. */
  settings: R1MeetGoogleSettings;
  /** `getR1MeetPublicConfig().meetMode`. */
  meetMode: GoogleMeetMode;
  /** Test seam: fully replaces the network (token endpoint, Calendar and Meet). */
  transport?: GoogleTransport;
  /** Clock in ms for the token cache and the JWT `iat`. Default `Date.now`. */
  now?: () => number;
  /** Metadata-only logger: one record per public call and one per token mint. */
  logger?: GoogleClientLogger;
  /** Per-request deadline (default 10 s, clamped 1..30 s). */
  timeoutMs?: number;
  /** Response cap (default 512 KiB, clamped 1 KiB..4 MiB). */
  maxResponseBytes?: number;
}

export interface R1MeetGoogle {
  calendar: GoogleCalendarClient;
  meet: GoogleMeetClient;
}

const CALENDAR_MODE_SCOPES: readonly GoogleScope[] = Object.freeze([
  GOOGLE_SCOPES.calendarEventsOwned,
  GOOGLE_SCOPES.meetSpaceSettings,
]);
const SPACE_MODE_SCOPES: readonly GoogleScope[] = Object.freeze([...CALENDAR_MODE_SCOPES, GOOGLE_SCOPES.meetSpaceCreated]);

/** The scopes Dex's token is minted for, by Meet mode (R9). */
export function r1MeetGoogleScopes(meetMode: GoogleMeetMode): readonly GoogleScope[] {
  return meetMode === 'space' ? SPACE_MODE_SCOPES : CALENDAR_MODE_SCOPES;
}

function buildTokenSource(o: R1MeetGoogleOptions, scopes: readonly GoogleScope[]): GoogleTokenSource {
  const settings = o.settings;
  const common = {
    scopes,
    ...(o.transport !== undefined ? { transport: o.transport } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.maxResponseBytes !== undefined ? { maxResponseBytes: o.maxResponseBytes } : {}),
  };
  switch (settings.authMode) {
    case 'oauth_refresh':
      return createGoogleOAuthRefreshTokenSource({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        refreshToken: settings.refreshToken,
        ...common,
      });
    case 'service_account':
      return createGoogleDwdTokenSource({
        key: {
          clientEmail: settings.clientEmail,
          privateKeyId: settings.privateKeyId,
          privateKey: settings.privateKey,
        },
        subject: settings.dexEmail,
        ...common,
      });
    default:
      throw new GoogleError('invalid_request');
  }
}

/**
 * The Calendar and Meet clients for Dex, sharing one token source picked by `settings.authMode`.
 * Throws `GoogleError('invalid_request')` synchronously, with zero network, on an unknown auth or
 * Meet mode, a missing (or spread-away) credential, or an unusable seam.
 */
export function createR1MeetGoogle(o: R1MeetGoogleOptions): R1MeetGoogle {
  if (typeof o !== 'object' || o === null) throw new GoogleError('invalid_request');
  const settings: unknown = o.settings;
  if (typeof settings !== 'object' || settings === null) throw new GoogleError('invalid_request');
  const meetMode = o.meetMode;
  if (meetMode !== 'calendar' && meetMode !== 'space') throw new GoogleError('invalid_request');

  const tokenSource = buildTokenSource(o, r1MeetGoogleScopes(meetMode));
  return buildClients(tokenSource, meetMode, o);
}

/** The Calendar and Meet clients over one token source (no network, no token). */
function buildClients(
  tokenSource: GoogleTokenSource,
  meetMode: GoogleMeetMode,
  seams: Pick<R1MeetGoogleOptions, 'transport' | 'logger' | 'timeoutMs' | 'maxResponseBytes'>,
): R1MeetGoogle {
  const shared = {
    tokenSource,
    ...(seams.transport !== undefined ? { transport: seams.transport } : {}),
    ...(seams.logger !== undefined ? { logger: seams.logger } : {}),
    ...(seams.timeoutMs !== undefined ? { timeoutMs: seams.timeoutMs } : {}),
    ...(seams.maxResponseBytes !== undefined ? { maxResponseBytes: seams.maxResponseBytes } : {}),
  };
  return Object.freeze({
    calendar: createGoogleCalendarClient(shared),
    meet: createGoogleMeetClient({ ...shared, meetMode }),
  });
}

// ── The process-wide token source (what the API uses) ───────────────────────

/**
 * What a runtime caller (S05 jobs, S06 routes) passes to `getR1MeetGoogle`. There is no transport and
 * no clock: those are process-wide (the real network and `Date.now`; tests set them once with
 * `setR1MeetGoogleTestSeams`), so no caller can split the token cache by passing its own.
 */
export interface R1MeetGoogleProcessOptions {
  /** `getR1MeetPublicConfig().google` (or the drain config's), read afresh per request or job. */
  settings: R1MeetGoogleSettings;
  /** `getR1MeetPublicConfig().meetMode` (one mode per process). */
  meetMode: GoogleMeetMode;
  /**
   * This caller's metadata-only logger: one record per Calendar or Meet call it makes, plus one per
   * token mint such a call starts. NOT part of the cache key: callers with different loggers share
   * one token.
   */
  logger?: GoogleClientLogger;
  /** This caller's deadline for its Calendar and Meet calls; token mints use the default 10 s. */
  timeoutMs?: number;
  /** This caller's response cap for its Calendar and Meet calls; token mints use the default 512 KiB. */
  maxResponseBytes?: number;
}

/** The process-wide test seams of `getR1MeetGoogle` (tests only; fence (g) refuses them in runtime code). */
export interface R1MeetGoogleTestSeams {
  /** Fully replaces the network: the token endpoint, Calendar and Meet. */
  transport?: GoogleTransport;
  /** Clock in ms for the token cache and the JWT `iat`. */
  now?: () => number;
}

interface ProcessTokens {
  /** SHA-256 of the auth mode, Dex's email and the chosen mode's credentials. */
  credential: string;
  /** One token source per Meet mode (the scopes differ); a process runs one mode. */
  byMeetMode: Map<GoogleMeetMode, GoogleTokenSource>;
}

let processTokens: ProcessTokens | null = null;
let testSeams: Readonly<R1MeetGoogleTestSeams> = Object.freeze({});

/**
 * A hash of the credential set: the auth mode, Dex's email and the chosen mode's credentials. The
 * secrets are hashed, so they are never held in a second place or compared as text (the
 * `lib/r1/recording/store-factory.ts` rule). Null when a part is missing (a spread-away secret) or
 * not text: then nothing is cached and the call is refused.
 */
function credentialSignatureOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const settings = raw as Readonly<Record<string, unknown>>;
  const parts: unknown[] = [settings.authMode, settings.dexEmail];
  if (settings.authMode === 'oauth_refresh') {
    parts.push(settings.clientId, settings.clientSecret, settings.refreshToken);
  } else if (settings.authMode === 'service_account') {
    parts.push(settings.clientEmail, settings.privateKeyId, settings.privateKey);
  } else {
    return null;
  }
  if (!parts.every((part) => typeof part === 'string')) return null;
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Dex's Google client for runtime code. S05/S06 call THIS on every request or job (with
 * `getR1MeetPublicConfig().google` or the drain config's), never `createR1MeetGoogle`: the token
 * source behind the returned Calendar and Meet clients is ONE per process for a credential set and
 * Meet mode, whatever logger or bounds the caller passes, so one token is cached and the 60 s refusal
 * window after `auth_revoked` / `setup_forbidden` holds for the whole process. The clients themselves
 * are built per call (no network, no token): each carries the caller's logger and bounds.
 *
 * A different credential set (a rotated secret: in production a Fly secret change, which restarts the
 * machine anyway) replaces the cached token sources, so an old secret is never kept; a refused
 * credential leaves the cached ones in place. Throws `GoogleError('invalid_request')` synchronously,
 * with zero network, on what `createR1MeetGoogle` refuses (an unknown auth or Meet mode, a missing,
 * spread-away or malformed credential, an unusable logger), and on a `transport` or `now` option
 * (process-wide test seams only).
 */
export function getR1MeetGoogle(o: R1MeetGoogleProcessOptions): R1MeetGoogle {
  if (typeof o !== 'object' || o === null) throw new GoogleError('invalid_request');
  // A per-caller transport or clock would split the token cache: refused loudly, never ignored.
  if ('transport' in o || 'now' in o) throw new GoogleError('invalid_request');
  const meetMode = o.meetMode;
  if (meetMode !== 'calendar' && meetMode !== 'space') throw new GoogleError('invalid_request');
  const credential = credentialSignatureOf(o.settings);
  if (credential === null) throw new GoogleError('invalid_request');

  const current = processTokens !== null && processTokens.credential === credential ? processTokens : null;
  const cached = current?.byMeetMode.get(meetMode);
  // Built with no logger and the default bounds, and shared by every caller.
  const tokenSource =
    cached ?? buildTokenSource({ settings: o.settings, meetMode, ...testSeams }, r1MeetGoogleScopes(meetMode));
  // This caller's view of it: a mint one of its calls starts logs to its own logger.
  const logger = o.logger;
  const callerTokens: GoogleTokenSource =
    logger === undefined
      ? tokenSource
      : Object.freeze({
          accessToken: () => tokenSource.accessToken({ logger }),
          invalidate: () => tokenSource.invalidate(),
        });
  const google = buildClients(callerTokens, meetMode, {
    transport: testSeams.transport,
    logger: o.logger,
    timeoutMs: o.timeoutMs,
    maxResponseBytes: o.maxResponseBytes,
  });
  if (cached === undefined) {
    const entry = current ?? { credential, byMeetMode: new Map<GoogleMeetMode, GoogleTokenSource>() };
    entry.byMeetMode.set(meetMode, tokenSource);
    processTokens = entry;
  }
  return google;
}

/**
 * Test seam: the transport and clock of every process-wide token source and client from now on (an
 * empty object restores the network and `Date.now`). Forgets the cached token sources, which were
 * built with the previous seams. Throws `GoogleError('invalid_request')` on a seam that is not a
 * function.
 */
export function setR1MeetGoogleTestSeams(seams: R1MeetGoogleTestSeams): void {
  if (typeof seams !== 'object' || seams === null) throw new GoogleError('invalid_request');
  const { transport, now } = seams;
  if (transport !== undefined && typeof transport !== 'function') throw new GoogleError('invalid_request');
  if (now !== undefined && typeof now !== 'function') throw new GoogleError('invalid_request');
  testSeams = Object.freeze({ ...(transport !== undefined ? { transport } : {}), ...(now !== undefined ? { now } : {}) });
  processTokens = null;
}

/** Test seam: forget the process-wide token sources and the test seams. */
export function resetR1MeetGoogleCache(): void {
  processTokens = null;
  testSeams = Object.freeze({});
}
