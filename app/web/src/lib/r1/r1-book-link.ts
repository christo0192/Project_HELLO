/**
 * Where the public booking pages live, and how `/book/manage` reads its manage token (M035 S07,
 * decision D-S07-M14; contracts section 6, "Tokens and digests").
 *
 * Invariants:
 *   - The manage token arrives only in the invite, as `<web>/book/manage#m=<token>`: 32 random
 *     bytes in base64url without padding, exactly 43 characters. It is read from the URL
 *     FRAGMENT only (a fragment is never sent to a server or in a Referer).
 *   - The address bar is reset to the bare `/book/manage` path at once, BEFORE the token is even
 *     validated, whatever the fragment held (the Meet bridge pattern, `captureMeetTicket` in
 *     r1-link.ts), so the token never lingers in the history entry, a bookmark or a screenshot.
 *   - The caller keeps the token in memory only. This module never stores it (no web storage,
 *     no cookie), never puts it in a URL and never logs it.
 */

export const R1_BOOK_PATH = '/book';
export const R1_BOOK_MANAGE_PATH = '/book/manage';

/** 32 random bytes as base64url, no padding: exactly 43 characters. */
const MANAGE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isManageToken(value: unknown): value is string {
  return typeof value === 'string' && MANAGE_TOKEN_RE.test(value);
}

/**
 * Read and strip the manage token from `#m=<token>`. Returns null when the fragment is missing,
 * has no `m`, or holds a token of the wrong shape. The address bar is reset to `/book/manage` in
 * every case, before validation.
 */
export function captureManageToken(win: Window = window): string | null {
  const raw = win.location.hash.slice(1);
  let value = '';
  try {
    value = raw ? (new URLSearchParams(raw).get('m') ?? '') : '';
  } catch {
    value = '';
  }
  win.history.replaceState(null, '', R1_BOOK_MANAGE_PATH);
  return isManageToken(value) ? value : null;
}
