/**
 * return-to.ts — the exact-path allowlist for post-login return navigation.
 *
 * Open-redirect posture (deliberate):
 *   - The return-to value travels ONLY in React Router location state. There is
 *     no `?next=` query parameter, so nothing an attacker can craft into a link
 *     to /login is ever honoured.
 *   - The allowlist matches EXACT paths, not prefixes: only the candidate-scoped
 *     Ashby review route, addressed by a well-formed UUID. Absolute URLs,
 *     protocol-relative `//host` values, paths with a query string or fragment,
 *     backslashes and anything else fail closed to null and the caller falls
 *     back to its normal landing route.
 */

/** Canonical route pattern for the candidate-scoped Ashby review page. */
export const ASHBY_REVIEW_ROUTE = '/ashby/review/:applicationLinkId';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Exact allowlist — extend this array (never loosen it to a prefix test). */
const ALLOWED_RETURN_TO: readonly RegExp[] = [
  new RegExp(`^/ashby/review/${UUID}$`),
];

/** Build the scoped review path for an opaque application link id. */
export function ashbyReviewPath(applicationLinkId: string): string {
  return `/ashby/review/${encodeURIComponent(applicationLinkId)}`;
}

/**
 * Return `value` when it is an allowlisted in-app path, otherwise null.
 * Never returns anything that could navigate off-origin.
 */
export function sanitizeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return ALLOWED_RETURN_TO.some((re) => re.test(value)) ? value : null;
}
