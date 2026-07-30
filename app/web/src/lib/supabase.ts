/**
 * Singleton Supabase client scoped to the `screening_v2` Postgres schema.
 * Realtime + anon SELECT are enabled server-side for the live-call tables.
 *
 * IMPORTANT: This module is safe to import even without env vars configured
 * (e.g., in tests). The client is created lazily. If env vars are missing,
 * calls to `supabase.auth` etc. will throw at usage time, not import time.
 *
 * ── Session Persistence (honest assessment) ────────────────────────────
 *
 * Supabase-js v2 persists the session to `localStorage` by default in
 * browser environments.  The SDK's internal `getSession()` rehydrates
 * from localStorage on page load, which means a cached session survives
 * page refresh.
 *
 * Our code does NOT touch localStorage/sessionStorage/cookies directly.
 * The Bearer access_token is read from the in-memory session object
 * obtained via `supabase.auth.getSession()` and attached to API requests
 * in the `api-client` module.  No second copy of the token is stored by
 * our application code.
 *
 * If localStorage is cleared or unavailable, the user must re-authenticate.
 *
 * ── SECURITY NOTE: PLAINTEXT LOCALSTORAGE & XSS RESIDUAL ──────────────
 * Supabase-js stores the session as **plaintext JSON** in localStorage.
 * There is no client-side encryption.  Any script running in the same
 * origin (including third-party scripts loaded by the app or injected
 * via XSS) can read `localStorage['sb-*-auth-token']` and extract the
 * access_token, refresh_token, and user data.
 *
 * This is standard OAuth2 session behaviour for SPAs and is the same
 * risk model as any app using Supabase Auth.  Mitigations are:
 *   - A strict CSP (no unsafe-inline, no unsafe-eval) — enforced by
 *     the Vite CSP plugin / build-time policy.
 *   - Short token expiry + refresh token rotation (handled by Supabase).
 *   - Our application code NEVER reads localStorage directly; the
 *     Bearer token is obtained from the in-memory Supabase session
 *     object, not from storage.
 *
 * ── Candidate / Browser Flow Isolation ─────────────────────────────────
 *
 * This client is exclusively for the recruiter dashboard (session-based
 * Supabase auth).  The candidate/browser flow (voice screening) does NOT
 * use this client — it uses ephemeral tokens issued by the API.  This
 * ensures the candidate flow never gains access to recruiter Supabase
 * queries.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

function createSupabaseClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    // Return a proxy that throws descriptive errors at call time instead
    // of failing at import time.  This keeps tests and SSR safe.
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined; // Not a Promise
          throw new Error(
            `Supabase client not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. ` +
              `Called property: "${String(prop)}"`,
          );
        },
      },
    ) as unknown as ReturnType<typeof createClient>;
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    db: { schema: 'screening_v2' },
  });
}

export const supabase = createSupabaseClient();
