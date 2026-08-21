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

/*
 * ── Surviving a full-page SSO redirect ──────────────────────────────────────
 * React Router location state does not survive the navigation to the identity
 * provider and back, so the (already sanitized) destination is parked in
 * sessionStorage for the duration of that round trip.
 *
 * Trust posture is unchanged: `sanitizeReturnTo` is applied on BOTH the write
 * and the read, so storage is not a trust boundary — a tampered value simply
 * fails the exact-path allowlist and the caller lands on its normal route. The
 * entry is single-use (deleted on read), same-tab only (sessionStorage), and
 * expires.
 *
 * There are TWO landing paths, and the entry must die on either:
 *   - the FALLBACK path (Supabase returns to the site URL) runs through
 *     `PostAuthLanding`, which consumes and deletes it;
 *   - the PROVIDER-HONOURED path (the deep link is a registered redirect URL)
 *     lands straight on the review page, so `PostAuthLanding` never runs — the
 *     page itself calls `clearReturnTo` on mount. Without that the entry
 *     survived its full TTL and re-routed a later visit to `/` in the same tab.
 */

const RETURN_TO_KEY = 'ashby.returnTo';

/** How long a parked return-to stays valid — one sign-in round trip. */
const RETURN_TO_TTL_MS = 10 * 60 * 1000;

/** How long a successful consume is replayed (StrictMode double-mount only). */
const CONSUME_REPLAY_MS = 5000;

let lastConsumed: { value: string; at: number } | null = null;

/** Park an allowlisted return-to across a full-page redirect. No-op otherwise. */
export function rememberReturnTo(value: unknown, now: number = Date.now()): void {
  const safe = sanitizeReturnTo(value);
  try {
    if (!safe) {
      window.sessionStorage.removeItem(RETURN_TO_KEY);
      return;
    }
    window.sessionStorage.setItem(RETURN_TO_KEY, JSON.stringify({ p: safe, t: now }));
  } catch {
    /* storage unavailable (private mode, disabled) — deep link degrades to the
       normal landing route, never to an error. */
  }
}

/**
 * Drop a parked return-to because the destination has been REACHED — the scoped
 * review page mounted, so no landing route should ever replay this value again.
 *
 * Also drops the StrictMode replay memo: the memo exists only to survive the
 * double-mount of the landing route, and by the time the destination page is
 * mounted the landing route is gone. Idempotent, and safe when storage is
 * unavailable.
 */
export function clearReturnTo(): void {
  lastConsumed = null;
  try {
    window.sessionStorage.removeItem(RETURN_TO_KEY);
  } catch {
    /* storage unavailable — nothing was parked, so nothing to clear. */
  }
}

/**
 * Read, delete and re-validate a parked return-to. Returns null unless the
 * stored value is a fresh, allowlisted in-app path.
 */
export function consumeReturnTo(now: number = Date.now()): string | null {
  // React StrictMode mounts the landing route twice in development, and the
  // read deletes the entry — so a successful consume is replayed for a few
  // seconds instead of collapsing to null on the second mount. The window is
  // deliberately tiny so a later navigation in the same page load is never
  // re-routed by an old link.
  if (lastConsumed && now - lastConsumed.at <= CONSUME_REPLAY_MS && now >= lastConsumed.at) {
    return lastConsumed.value;
  }
  lastConsumed = null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(RETURN_TO_KEY);
    window.sessionStorage.removeItem(RETURN_TO_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { p?: unknown; t?: unknown };
    const stamped = typeof parsed?.t === 'number' ? parsed.t : 0;
    if (!Number.isFinite(stamped) || now - stamped > RETURN_TO_TTL_MS || now < stamped) return null;
    const value = sanitizeReturnTo(parsed?.p);
    if (value) lastConsumed = { value, at: now };
    return value;
  } catch {
    return null;
  }
}

/** Test-only: drop the short replay memo so each case starts clean. */
export function resetReturnToReplay(): void {
  lastConsumed = null;
}
