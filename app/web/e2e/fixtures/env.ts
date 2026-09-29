/**
 * The fixed facts the whole offline harness agrees on.
 *
 * Imported by BOTH the Playwright config (Node, before any browser exists) and
 * the fixtures (Node, per test), so the dev server is booted with exactly the
 * origins the route interceptors later answer for. Nothing here may import a
 * browser-only or app-runtime module.
 *
 * WHY `.invalid` HOSTS. RFC 2606 reserves `.invalid` so it can never resolve.
 * Every backend the app talks to is pointed at one, which turns "zero network
 * access to real backends" from a promise into a property: a request the
 * interceptors somehow miss fails DNS instead of reaching anything real.
 */

/** Where `apiClient` sends every `/api/*` call (VITE_API_BASE). */
export const MOCK_API_ORIGIN = 'http://api.e2e.invalid';

/** Supabase auth + PostgREST + Realtime (VITE_SUPABASE_URL). */
export const MOCK_SUPABASE_ORIGIN = 'http://supabase.e2e.invalid';

/** LiveKit signalling. Required by the CSP plugin; never dialled by a test. */
export const MOCK_LIVEKIT_ORIGIN = 'ws://livekit.e2e.invalid';

/** Sent as `apikey` by supabase-js. Deliberately not shaped like a real key. */
export const MOCK_ANON_KEY = 'e2e-anon-key-not-a-secret';

/**
 * supabase-js derives its localStorage key from the FIRST DNS label of the
 * project URL: `sb-${hostname.split('.')[0]}-auth-token`. Kept next to the
 * origin it is derived from so the two cannot drift apart.
 */
export const SUPABASE_STORAGE_KEY = `sb-${new URL(MOCK_SUPABASE_ORIGIN).hostname.split('.')[0]}-auth-token`;

/**
 * The instant every page believes it is (`page.clock.setFixedTime`).
 *
 * Wednesday 16 Sep 2026, 12:00 IST. A weekday mid-week so the phone calendar's
 * default week has appointments on both sides of "now", and every relative
 * date the fixtures emit ("2 days ago", "this week") renders identically on
 * every run — the precondition for a screenshot worth diffing.
 */
export const FROZEN_NOW_ISO = '2026-09-16T06:30:00.000Z';
export const FROZEN_NOW_MS = Date.parse(FROZEN_NOW_ISO);

/** Browser locale and zone: the recruiters this app serves work in IST. */
export const E2E_LOCALE = 'en-IN';
export const E2E_TIMEZONE = 'Asia/Kolkata';

/** Environment the Vite dev server is started with (see playwright.config). */
export function viteEnv(): Record<string, string> {
  return {
    VITE_API_BASE: MOCK_API_ORIGIN,
    VITE_SUPABASE_URL: MOCK_SUPABASE_ORIGIN,
    VITE_SUPABASE_ANON_KEY: MOCK_ANON_KEY,
    VITE_LIVEKIT_URL: MOCK_LIVEKIT_ORIGIN,
    // The CSP plugin refuses to start without a mode; report-only is the only
    // one it allows in dev. The context runs with `bypassCSP` (see config).
    VITE_CSP_MODE: 'report-only',
    // Explicitly empty: no report endpoint means the browser never POSTs a
    // CSP report anywhere.
    VITE_CSP_REPORT_ENDPOINT: '',
    VITE_SSO_PROVIDERS: '',
    VITE_CANDIDATE_WEBRTC_V2: 'true',
  };
}
