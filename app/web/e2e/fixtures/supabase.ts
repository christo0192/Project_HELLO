/**
 * Everything the app expects from Supabase, answered locally.
 *
 * THE SESSION. supabase-js restores a session from localStorage on boot and
 * never re-validates the JWT signature client-side, so the harness seeds a
 * well-formed but UNSIGNED token (`alg: "none"`, RFC 7519 §6) before any page
 * script runs. Nothing downstream can mistake it for a real credential, and
 * nothing downstream needs one: the app treats Supabase as an authenticator
 * only — the role comes from `GET /api/me`, which the API router answers.
 *
 * WHAT THE APP ACTUALLY CALLS on a restored session (see src/lib/auth.tsx):
 *   - `getSession()`                         → localStorage only, no network
 *   - `mfa.getAuthenticatorAssuranceLevel()` → decodes the JWT's `aal` claim
 *   - `mfa.listFactors()`                    → `GET /auth/v1/user`
 *   - token refresh                          → only inside the 90 s expiry
 *                                              margin, which the far-future
 *                                              `exp` + frozen clock never reach
 * plus, from the candidate page's live-call panel, PostgREST reads and a
 * Realtime websocket. Every other Supabase path falls through to the harness's
 * loud "unmocked" handler.
 */

import type { Page, WebSocketRoute } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_USER_ID } from './data';
import { FROZEN_NOW_MS, MOCK_SUPABASE_ORIGIN, SUPABASE_STORAGE_KEY } from './env';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const NOW_S = Math.floor(FROZEN_NOW_MS / 1000);
/** Ten years past the frozen clock: auto-refresh never triggers. */
const EXP_S = NOW_S + 10 * 365 * 24 * 3600;
const FACTOR_ID = 'f0000000-0000-4000-8000-00000000f0a1';

/**
 * The admin's JWT claims.
 *
 * `role` stays `authenticated` because in a Supabase JWT that claim is the
 * POSTGRES role, not the product role; the product role is carried where the
 * task and the old UI gate looked for it (`app_role`, `app_metadata.role`).
 * `aal2` + a verified TOTP factor means "MFA satisfied", even though ADR-0011
 * made MFA a non-input — so the session is valid under either policy.
 */
const CLAIMS = {
  iss: `${MOCK_SUPABASE_ORIGIN}/auth/v1`,
  aud: 'authenticated',
  sub: ADMIN_USER_ID,
  email: ADMIN_EMAIL,
  phone: '',
  role: 'authenticated',
  app_role: 'admin',
  aal: 'aal2',
  amr: [
    { method: 'oauth', timestamp: NOW_S - 3600 },
    { method: 'totp', timestamp: NOW_S - 3500 },
  ],
  app_metadata: { provider: 'google', providers: ['google'], role: 'admin' },
  user_metadata: { full_name: 'E2E Admin' },
  session_id: 'e2e00000-0000-4000-8000-00000000cafe',
  is_anonymous: false,
  iat: NOW_S - 3600,
  exp: EXP_S,
};

export const ACCESS_TOKEN = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(CLAIMS)}.`;

const created = new Date(FROZEN_NOW_MS - 120 * 86_400_000).toISOString();
const lastSignIn = new Date(FROZEN_NOW_MS - 3_600_000).toISOString();

/** The GoTrue user object (`GET /auth/v1/user`, and embedded in the session). */
export const AUTH_USER = {
  id: ADMIN_USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: ADMIN_EMAIL,
  email_confirmed_at: created,
  phone: '',
  confirmed_at: created,
  last_sign_in_at: lastSignIn,
  app_metadata: CLAIMS.app_metadata,
  user_metadata: CLAIMS.user_metadata,
  identities: [],
  factors: [
    { id: FACTOR_ID, friendly_name: 'Authenticator app', factor_type: 'totp', status: 'verified', created_at: created, updated_at: created },
  ],
  created_at: created,
  updated_at: lastSignIn,
  is_anonymous: false,
};

/** Exactly the JSON supabase-js persists under `sb-<ref>-auth-token`. */
export const PERSISTED_SESSION = {
  access_token: ACCESS_TOKEN,
  token_type: 'bearer',
  expires_in: EXP_S - NOW_S,
  expires_at: EXP_S,
  refresh_token: 'e2e-refresh-token-not-a-secret',
  user: AUTH_USER,
};

/**
 * Seed the session before ANY page script runs, on every navigation. It is
 * re-seeded after an in-test sign-out too, which is what a test that wants
 * the signed-out state would override with its own init script.
 */
export async function seedAdminSession(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [SUPABASE_STORAGE_KEY, JSON.stringify(PERSISTED_SESSION)] as const,
  );
}

export interface SupabaseReply {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

/**
 * `/auth/v1/*` and `/rest/v1/*`. Returns `null` for anything it does not know,
 * which the harness turns into a loud, recorded 500.
 */
export function supabaseReply(method: string, url: URL): SupabaseReply | null {
  const path = url.pathname;

  if (path === '/auth/v1/user' && method === 'GET') return { status: 200, json: AUTH_USER };
  if (path === '/auth/v1/token' && method === 'POST') {
    // Only reachable if a test deliberately expires the session.
    return { status: 200, json: { ...PERSISTED_SESSION, user: AUTH_USER } };
  }
  if (path === '/auth/v1/logout' && method === 'POST') return { status: 204 };
  // MFA endpoints behind the (unrouted) enroll/challenge pages, answered so a
  // future test of those pages starts from a working baseline.
  const factor = /^\/auth\/v1\/factors\/([^/]+)\/(challenge|verify)$/.exec(path);
  if (factor && method === 'POST') {
    return factor[2] === 'challenge'
      ? { status: 200, json: { id: 'e2e-challenge', type: 'totp', expires_at: EXP_S } }
      : { status: 200, json: { ...PERSISTED_SESSION, user: AUTH_USER } };
  }

  // PostgREST. The only reads are the live-call panel's, and "no live call"
  // is the truthful state of a review page, so every known table is empty.
  // An unknown table is a new dependency and must surface as unmocked.
  const table = /^\/rest\/v1\/([a-z_]+)$/.exec(path)?.[1];
  if (table && method === 'GET' && ['call_sessions', 'transcript_turns', 'assessments'].includes(table)) {
    return { status: 200, json: [], headers: { 'content-range': '*/0' } };
  }
  return null;
}

/** Where supabase-js opens its Realtime socket, on the Supabase origin. */
export const REALTIME_PATH = '/realtime/v1/websocket';

/**
 * Supabase Realtime (Phoenix channels, serializer vsn 2.0.0: every frame is
 * `[join_ref, ref, topic, event, payload]`). Joins and heartbeats are
 * acknowledged so the client settles into "subscribed" instead of retrying
 * and timing out; no change events are ever pushed. Postgres-changes bindings
 * are echoed back with ids, because realtime-js treats a binding mismatch as
 * a channel error.
 *
 * Matches the MOCK Supabase host only: a Realtime socket to any other host is
 * not ours to answer and must reach the harness's external-WebSocket guard.
 * Register this AFTER that catch-all guard (see harness.ts) — for WebSockets
 * the most recently registered matching route is the one that runs.
 */
export async function mockRealtime(page: Page): Promise<void> {
  const host = new URL(MOCK_SUPABASE_ORIGIN).host;
  const isMockRealtime = (url: URL): boolean => url.host === host && url.pathname === REALTIME_PATH;
  await page.routeWebSocket(isMockRealtime, (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      const [joinRef, ref, topic, event, payload] = frame as [string | null, string | null, string, string, Record<string, unknown>];
      const reply = (response: unknown) =>
        ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]));
      if (event === 'heartbeat' || event === 'phx_leave') reply({});
      if (event === 'phx_join') {
        const config = (payload?.config ?? {}) as { postgres_changes?: Array<Record<string, unknown>> };
        reply({ postgres_changes: (config.postgres_changes ?? []).map((binding, i) => ({ ...binding, id: 7000 + i })) });
      }
    });
  });
}
