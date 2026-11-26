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
 * - ONE token source is shared by the Calendar and the Meet clients, so a booking mints one token.
 * - Construction makes no network call and mints no token; a bad setting throws
 *   `GoogleError('invalid_request')` synchronously.
 */

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
  const shared = {
    tokenSource,
    ...(o.transport !== undefined ? { transport: o.transport } : {}),
    ...(o.logger !== undefined ? { logger: o.logger } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.maxResponseBytes !== undefined ? { maxResponseBytes: o.maxResponseBytes } : {}),
  };
  return Object.freeze({
    calendar: createGoogleCalendarClient(shared),
    meet: createGoogleMeetClient({ ...shared, meetMode }),
  });
}
