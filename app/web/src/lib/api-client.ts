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
  /**
   * The machine code the API sent, or null when it sent none. For deciding
   * what to do and for looking up copy (api-error-copy.ts), never for printing.
   * `message` still holds what it always did, because phoneErrors.ts, lib/r1.ts
   * and others read their codes from it.
   */
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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

function errorMessageFromBody(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const body = data as { error?: unknown; message?: unknown };
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (body.error && typeof body.error === 'object') {
    const nested = body.error as { message?: unknown; type?: unknown };
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message;
    if (typeof nested.type === 'string' && nested.type.trim()) return nested.type;
  }
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  return fallback;
}

/** A bare `error` that reads as a code, or the envelope's `error.type`. A sentence is not a code. */
function errorCodeFromBody(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const { error } = data as { error?: unknown };
  if (typeof error === 'string') return /^\S+$/.test(error) ? error : null;
  if (error && typeof error === 'object') {
    const { type } = error as { type?: unknown };
    if (typeof type === 'string' && type.trim()) return type;
  }
  return null;
}

async function parseError(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  let code: string | null = null;
  try {
    const data: unknown = await res.json();
    message = errorMessageFromBody(data, message);
    code = errorCodeFromBody(data);
  } catch {
    // ignore non-JSON error bodies
  }
  throw new ApiError(message, res.status, code);
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
