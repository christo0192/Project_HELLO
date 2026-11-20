/**
 * calendly/settings.ts — pure validators and constants for the Calendly integration.
 *
 * Reads NO environment and performs no I/O: the Meet config reader (`lib/r1/meet/config.ts`) is the
 * only module that reads the variables, and it hands the values it read to these validators.
 *
 * Calendly identifies every resource by a full URI on one fixed origin, e.g.
 * `https://api.calendly.com/event_types/<id>`. The parsers below accept exactly that shape (no
 * trailing slash, query, fragment, port or userinfo) and return the id segment, so an id that
 * reaches a request path is always one safe segment.
 *
 * SECURITY: nothing here logs, and no validator echoes its input in a result or an error.
 */

/** Calendly's API origin. Fixed: there is no regional or override base URL. */
export const CALENDLY_API_BASE_URL = 'https://api.calendly.com';

/** One resource id segment: letters, digits and hyphens (Calendly ids and UUIDs), 1..64 chars. */
export const CALENDLY_ID_SEGMENT_RE = /^[A-Za-z0-9-]{1,64}$/;

export type CalendlyCollection =
  | 'event_types'
  | 'scheduled_events'
  | 'users'
  | 'organizations'
  | 'webhook_subscriptions';

const COLLECTIONS: ReadonlySet<string> = new Set<CalendlyCollection>([
  'event_types',
  'scheduled_events',
  'users',
  'organizations',
  'webhook_subscriptions',
]);

const INVITEE_URI = new RegExp(
  '^https://api\\.calendly\\.com/scheduled_events/([A-Za-z0-9-]{1,64})/invitees/([A-Za-z0-9-]{1,64})$',
);

const TOKEN_SHAPE = /^[\x21-\x7e]{20,4096}$/;
const SIGNING_KEY_SHAPE = /^[\x21-\x7e]{16,256}$/;

function isCollection(value: unknown): value is CalendlyCollection {
  return typeof value === 'string' && COLLECTIONS.has(value);
}

/**
 * The id segment of exactly `https://api.calendly.com/<collection>/<id>`, or null. The id regex
 * excludes `/`, `?`, `#`, `%` and `.`, so a prefix match plus the id check is the whole parse.
 */
export function parseCalendlyUri(raw: unknown, collection: CalendlyCollection): string | null {
  if (typeof raw !== 'string' || !isCollection(collection)) return null;
  const prefix = `${CALENDLY_API_BASE_URL}/${collection}/`;
  if (!raw.startsWith(prefix)) return null;
  const id = raw.slice(prefix.length);
  return CALENDLY_ID_SEGMENT_RE.test(id) ? id : null;
}

/** Both ids of `https://api.calendly.com/scheduled_events/<eventId>/invitees/<inviteeId>`, or null. */
export function parseCalendlyInviteeUri(raw: unknown): { eventId: string; inviteeId: string } | null {
  if (typeof raw !== 'string') return null;
  const match = INVITEE_URI.exec(raw);
  return match ? { eventId: match[1], inviteeId: match[2] } : null;
}

/**
 * `https://api.calendly.com/<collection>/<id>`. Throws a plain `TypeError` on an unknown collection
 * or an id that is not one safe segment; callers validate first. The message never echoes the id.
 */
export function calendlyUri(collection: CalendlyCollection, id: string): string {
  if (!isCollection(collection)) throw new TypeError('calendly_uri_invalid_collection');
  if (typeof id !== 'string' || !CALENDLY_ID_SEGMENT_RE.test(id)) throw new TypeError('calendly_uri_invalid_id');
  return `${CALENDLY_API_BASE_URL}/${collection}/${id}`;
}

/** Plausible personal access / OAuth token: 20..4096 printable ASCII characters. */
export function isCalendlyTokenShaped(raw: unknown): raw is string {
  return typeof raw === 'string' && TOKEN_SHAPE.test(raw);
}

/** Plausible webhook signing key: 16..256 printable ASCII characters. */
export function isCalendlySigningKeyShaped(raw: unknown): raw is string {
  return typeof raw === 'string' && SIGNING_KEY_SHAPE.test(raw);
}
