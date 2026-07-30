/**
 * API client that attaches the Supabase bearer access token to every request.
 *
 * Token is obtained from the in-memory Supabase session — the single source
 * of truth.  No token copy is stored in localStorage/sessionStorage/cookies
 * or leaked to URL/log/error/DOM by this module.
 *
 * Supabase-js v2 persistence note:
 *   Supabase-js persists the session to localStorage by default in browser
 *   environments (via the built-in `getItem`/`setItem` calls on the
 *   `supabase.auth` client).  This is Supabase's own SDK behaviour and is
 *   NOT a second copy — it is the same session that the SDK manages.
 *   Upon page reload, Supabase rehydrates the session from localStorage
 *   into memory, and THIS module reads the access_token from the in-memory
 *   session object.  The localStorage copy is managed entirely by the
 *   Supabase SDK internals and is never read/written by our code.
 *
 *   SECURITY: The localStorage value is **plaintext JSON** (not encrypted).
 *   Any script executing in this origin can read it via
 *   `localStorage.getItem('sb-*-auth-token')`.  Mitigation relies on the
 *   strict CSP (no unsafe-inline, no unsafe-eval) enforced at build time
 *   and the fact that our code never reads/writes localStorage directly.
 */

import { supabase } from './supabase';

const BASE_URL = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Custom event dispatched when the API returns a 401 Unauthorized.
 * The AuthProvider listens for this to clear the session.
 */
export const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';

function dispatchUnauthorized(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
  }
}

async function parseError(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const data = (await res.json()) as { error?: string; message?: string };
    if (data?.error) message = data.error;
    else if (data?.message) message = data.message;
  } catch {
    // ignore non-JSON error bodies
  }
  throw new ApiError(message, res.status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Get the current access token from the Supabase session (in memory).
  // Defensive: handle case where getSession() might fail or return unexpected
  // shape (e.g. in tests without full Supabase config).
  let token: string | null = null;
  try {
    const result = await supabase.auth.getSession();
    token = result?.data?.session?.access_token ?? null;
  } catch {
    // Silently continue without token if session check fails.
    token = null;
  }

  const headers: Record<string, string> = {
    ...((init?.body && !(init.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : {}) as Record<string, string>),
    ...(init?.headers as Record<string, string> | undefined),
  };

  // Attach Bearer token if available — never leak to URL/log/error/DOM.
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new ApiError(
      'Could not reach the server. Is the API running on ' + BASE_URL + '?',
      0,
    );
  }

  // 401 → dispatch event so AuthProvider can clear session
  if (res.status === 401) {
    dispatchUnauthorized();
  }

  if (!res.ok) return parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiClient = {
  request,
  BASE_URL,
};
