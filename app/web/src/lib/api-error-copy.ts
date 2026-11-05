/**
 * A failed API read, in words a recruiter can act on.
 *
 * The client makes the response's `error` the thrown error's message
 * (api-client.ts), and that is a machine code or a line written for developers:
 * `service_unavailable`, 'Internal server error'. Printed as it is, a recruiter
 * learns nothing about what happened or what to do next.
 *
 * Same model as the phone calendar (components/phone-calendar/phoneErrors.ts):
 *
 *   - The mapped set is an ALLOWLIST. An unmapped code gets one generic sentence
 *     and its text is never printed, so nothing a future error happens to carry
 *     can reach the page by default.
 *   - The status outranks the body. A 429 is a pacing limit on this account and
 *     never reads as an outage; a 403 is a role fact, not a fault.
 *
 * NEUTRAL ABOUT THE ACTION. This copy says what went wrong, never what was being
 * attempted: these codes answer writes as well as reads, and a failed delete must
 * not read as "this could not be loaded" above a list that did load. A page that
 * knows what it was doing says that part itself ("Could not remove the agent.").
 *
 * It takes anything thrown and reads it by shape rather than `instanceof`: a
 * bug's TypeError lands here too, and it keeps this module free of the API
 * client, so the design system's ErrorPanel can use it.
 */

const NOT_ALLOWED = 'Your role does not give you access to this. Ask an administrator if you need it.';
const SESSION_ENDED = 'Your session has ended. Sign in again to continue.';
const RATE_LIMITED =
  'Too many requests in a short time. Wait a moment and try again. This is a limit on your account, not a fault in HELLO.';
const UNREACHABLE = 'The server could not be reached. Check your connection and try again.';
const SERVER_FAILED =
  'Something went wrong on the server. Try again. If it keeps happening, contact an administrator.';
const MAINTENANCE = 'HELLO is under maintenance. Try again once maintenance ends.';
const REQUEST_REFUSED =
  'The request was not accepted. Refresh the page and try again. If it keeps happening, contact an administrator.';

/** For an unmapped code, and for anything thrown that is not an API error at all. */
export const GENERIC_ERROR_COPY =
  'Something went wrong. Try again. If it keeps happening, contact an administrator.';

/**
 * Keyed by code. The API's error envelope also carries a developer's message
 * beside its `type`, and call sites hand that message around as the error's
 * text, so those lines are keys here too.
 */
export const API_ERROR_COPY: Readonly<Record<string, string>> = {
  // GET /api/candidates and /summary when a batched assessments read fails
  // (fail closed, routes/candidates.ts): the rows exist, this load did not get
  // them. Also a write's answer (POST /api/screening/start), so it names neither.
  service_unavailable: 'HELLO could not complete this just now. This is usually brief, so try again in a moment.',

  // lib/maintenance.ts
  maintenance_mode: MAINTENANCE,
  'Service temporarily unavailable': MAINTENANCE,

  // lib/validation.ts, the final error handler
  internal_error: SERVER_FAILED,
  'Internal server error': SERVER_FAILED,

  // lib/auth.ts
  authentication_error: SESSION_ENDED,
  'Authentication required': SESSION_ENDED,
  unauthorized: SESSION_ENDED,
  authorization_error: NOT_ALLOWED,
  'Insufficient permissions': NOT_ALLOWED,
  forbidden: NOT_ALLOWED,
  access_denied: NOT_ALLOWED,

  // lib/rate-limit.ts
  rate_limit_exceeded: RATE_LIMITED,
  rate_limited: RATE_LIMITED,
  'Too many requests. Please try again later.': RATE_LIMITED,

  // lib/validation.ts
  validation_error: REQUEST_REFUSED,
  'Request validation failed': REQUEST_REFUSED,
  malformed_request: REQUEST_REFUSED,

  not_found: 'This could not be found. It may have been removed, so refresh the page and check.',
  candidate_not_found: 'This candidate could not be found, or is not visible to your account.',

  // Phone reads a page outside the calendar can hit (the Dashboard's schedule).
  phone_read_error: 'Phone data could not be read just now. Try again in a moment.',
  phone_screening_disabled: 'Phone screening is turned off.',
};

/**
 * `Object.hasOwn`, not a bare index: a code of `constructor` or `toString` would
 * otherwise resolve to an inherited Function typed as a string, which React
 * refuses to render.
 */
function mapped(key: unknown): string | null {
  return typeof key === 'string' && Object.hasOwn(API_ERROR_COPY, key) ? API_ERROR_COPY[key] : null;
}

/** Plain words for anything a read can throw. Never returns the error's own text. */
export function apiErrorCopy(error: unknown): string {
  if (!error || typeof error !== 'object') return GENERIC_ERROR_COPY;
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };

  if (status === 0) return UNREACHABLE;
  if (status === 429) return RATE_LIMITED;
  if (status === 403) return NOT_ALLOWED;
  if (status === 401) return SESSION_ENDED;

  // The message as well as the code: an error built without one keeps its code
  // there, and the envelope's message may be mapped when its type is not.
  return mapped(code) ?? mapped(message) ?? GENERIC_ERROR_COPY;
}

/** Text no person wrote for this page, however it got here. */
const MACHINE_TEXT: readonly RegExp[] = [
  // One token with no closing punctuation: `boom`, `PGRST116`, `toString`.
  /^\S*[^\s.!?]$/,
  // snake_case anywhere: `not_found: candidate c-1`.
  /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/i,
  // The client's fallback when a body has no error: `500 Internal Server Error`.
  /^\d{3}\b/,
  // A URL (presigned ones included) or an email address.
  /https?:\/\//i,
  /\S@\S/,
];

/**
 * The last check before a string reaches the page, for code that only has text:
 * the ErrorPanel, and callers that compose a label with an error's message.
 * Sentences a page wrote pass through; a mapped code is translated; anything
 * that reads like machine text becomes the generic sentence. Anything that
 * still has the error itself should use `apiErrorCopy`, because only it can see
 * the status.
 */
export function plainErrorText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return GENERIC_ERROR_COPY;
  // The client's own transport message names the API origin.
  if (trimmed.startsWith('Could not reach the server')) return UNREACHABLE;
  const known = mapped(trimmed);
  if (known) return known;
  return MACHINE_TEXT.some((pattern) => pattern.test(trimmed)) ? GENERIC_ERROR_COPY : text;
}
