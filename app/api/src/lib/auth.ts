/**
 * SEC-01 / SEC-02: Bearer token authentication via Supabase Auth.
 *
 * Extracts a Bearer token from the Authorization header, verifies it
 * through Supabase Auth's getUser() API (never merely decodes), and
 * enforces AAL2 and active membership for privileged endpoints.
 *
 * AAL is derived ONLY from the validated JWT's top-level `aal` claim
 * via a strict bounded payload parse — never from app_metadata or
 * user_metadata, which are user-influenceable.
 *
 * Distinguishes:
 *   401 — malformed/missing/duplicated/oversized Authorization header,
 *         invalid or expired token, token revoked, user not found.
 *   403 — authenticated but AAL < 2, or membership inactive.
 *
 * No cookie/CSRF; Bearer transport only.
 *
 * DEPENDENCY INJECTION: verifyToken() accepts an optional deps object.
 * The middleware wrapper in createApp() threads CreateAppOptions.authDeps
 * through so tests never call a live Supabase provider.
 */

import type { NextFunction, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Module-level state (set once at app creation) ────────────────────

let _supabaseClient: SupabaseClient | null = null;

/**
 * Inject the Supabase client used for token verification.
 * Must be called once during app creation before any auth middleware runs.
 */
export function setAuthSupabaseClient(client: SupabaseClient): void {
  _supabaseClient = client;
}

function getClient(): SupabaseClient {
  if (!_supabaseClient) {
    throw new Error(
      'auth: Supabase client not configured. Call setAuthSupabaseClient() in createApp().',
    );
  }
  return _supabaseClient;
}

// ── Types ────────────────────────────────────────────────────────────

export interface AuthUser {
  /** Supabase Auth user ID (sub claim). */
  id: string;
  /** Email from the JWT (may be null for SSO/phone users). */
  email: string | null;
  /** AAL (Authentication Assurance Level): 'aal1' or 'aal2'. */
  aal: string;
  /** Whether the user's membership is active. */
  active: boolean;
  /** User role within the HR application. */
  appRole: 'admin' | 'interviewer' | 'viewer';
  /** Organization scope (admin within one org). Null for viewers. */
  orgId: string | null;
  /**
   * Whether the email is CONFIRMED/verified by Supabase Auth
   * (email_confirmed_at is set). Access gate input — never trust OAuth hd.
   * Optional so injected test users that predate the gate keep compiling;
   * the live access resolver treats missing/undefined as UNVERIFIED
   * (fail closed).
   */
  emailVerified?: boolean;
}

/**
 * Result of token verification.
 */
export type AuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; status: 401; message: string }
  | { ok: false; status: 403; message: string };

/**
 * Result of the per-request access resolution (allowlist + domain gate).
 * A non-ok result maps to a uniform generic 403 — identical for wrong
 * domain, not-allowlisted, inactive, disabled, and relink denials.
 */
export type AccessResolution =
  | { ok: true; role: 'admin' | 'interviewer' | 'viewer'; active: boolean }
  | { ok: false; status: 403 };

/**
 * Access resolver signature — injectable test seam. Called by the auth
 * middleware on EVERY request (live default: resolve_allowlist_access RPC).
 */
export type AccessResolver = (
  userId: string,
  email: string,
  emailVerified: boolean,
) => Promise<AccessResolution>;

/**
 * Verifier function signature — injectable test seam.
 */
export type TokenVerifier = (token: string) => Promise<{
  data: { user: Record<string, unknown> | null };
  error: { message: string } | null;
}>;

export type MembershipResolver = (userId: string) => Promise<{
  role: 'admin' | 'interviewer' | 'viewer';
  active: boolean;
} | null>;

// ── Access gate: normalized company email allowlist ─────────────────────

/** The ONLY accepted email domain (Google Workspace company account). */
export const ALLOWED_ACCESS_DOMAIN = 'interviewkickstart.com';

/**
 * Normalize a Supabase-verified email for the access gate.
 *
 * Strict ASCII trim + lower normalization:
 *   - rejects any non-ASCII (printable-range) character (unicode tricks);
 *   - trims whitespace and lowercases;
 *   - strips a "Display Name <email>" wrapper;
 *   - requires EXACTLY ONE '@';
 *   - requires a valid local part and dotted domain;
 *   - requires the EXACT domain interviewkickstart.com (no subdomains,
 *     no suffix tricks — e.g. a@interviewkickstart.com.evil.test fails).
 *
 * Returns null when the email cannot be safely normalized — the caller
 * must treat that as a 403 (uniform generic denial). OAuth `hd` is NEVER
 * consulted: only the Supabase-verified user email is authoritative.
 */
export function normalizeEmailForAccess(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // Strict ASCII: reject any character outside printable ASCII.
  if (/[^\x20-\x7E]/.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  // Strip a "Display Name <email>" wrapper, if any (strict: must end in '>').
  const angle = /^.*<([^<>]+)>$/.exec(lower);
  const email = (angle ? angle[1] : lower).trim();
  // Exactly one '@'.
  const atIndex = email.indexOf('@');
  if (atIndex === -1 || email.indexOf('@', atIndex + 1) !== -1) return null;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (!/^[a-z0-9._%+\-]+$/.test(local)) return null;
  if (!/^[a-z0-9.\-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (domain !== ALLOWED_ACCESS_DOMAIN) return null;
  return `${local}@${domain}`;
}

/**
 * Default live access resolver: normalizes the verified Supabase email,
 * enforces the exact company domain, then calls the atomic
 * resolve_allowlist_access SECURITY DEFINER RPC (fixed search_path,
 * service-role-only). The RPC locks the allowlist entry, rejects
 * missing/inactive/domain-mismatch/relink, links on first login, and
 * creates/updates recruiter_memberships from the SERVER-HELD allowlist
 * role. A disabled entry denies even with a valid old JWT / stale
 * membership. Every failure path returns the same generic 403.
 */
export async function defaultAccessResolver(
  userId: string,
  email: string,
  emailVerified: boolean,
): Promise<AccessResolution> {
  // Verified Supabase email required (email_confirmed_at set).
  if (!emailVerified) return { ok: false, status: 403 };
  const normalized = normalizeEmailForAccess(email);
  if (!normalized) return { ok: false, status: 403 };
  try {
    const { data, error } = await getClient().rpc('resolve_allowlist_access', {
      p_user_id: userId,
      p_email: email,
    });
    if (error || !data) return { ok: false, status: 403 };
    const record = data as { status?: string; role?: string; active?: boolean };
    if (record.status !== 'ok') return { ok: false, status: 403 };
    const role = record.role;
    if (!role || !['admin', 'interviewer', 'viewer'].includes(role)) {
      return { ok: false, status: 403 };
    }
    return {
      ok: true,
      role: role as 'admin' | 'interviewer' | 'viewer',
      active: record.active === true,
    };
  } catch {
    return { ok: false, status: 403 };
  }
}

// ── Constants ────────────────────────────────────────────────────────

const BEARER_RE = /^Bearer\s+(\S+)$/;
const MAX_TOKEN_LENGTH = 4096;
const MIN_TOKEN_LENGTH = 16;

// ── Token extraction ─────────────────────────────────────────────────

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;

  // Reject array headers (duplicate)
  if (Array.isArray(authHeader)) return null;
  if (typeof authHeader !== 'string') return null;

  // Reject oversized
  if (authHeader.length > MAX_TOKEN_LENGTH) return null;

  const match = BEARER_RE.exec(authHeader);
  if (!match) return null;

  const token = match[1];
  // Basic sanity: JWT tokens have at least 2 dots and reasonable length
  if (token.length < MIN_TOKEN_LENGTH) return null;
  if (!token.includes('.')) return null;

  return token;
}

/**
 * Stable non-sensitive JSON for auth failures.
 * Never leaks token, user ID, or reason details beyond the invariant contract.
 */
export function authErrorBody(status: 401 | 403): Record<string, unknown> {
  return {
    error: {
      type: status === 401 ? 'authentication_error' : 'authorization_error',
      message: status === 401 ? 'Authentication required' : 'Insufficient permissions',
    },
  };
}

// ── JWT payload parsing (bounded, strict) ────────────────────────────

const MAX_JWT_PAYLOAD_BYTES = 4096;

/**
 * Parse the payload (middle segment) of a JWT and return the top-level claims.
 *
 * This is a STRICT, BOUNDED parse — rejects payloads larger than 4 KiB,
 * non-base64url characters, and non-object top-level JSON.
 *
 * Purpose: extract the `aal` claim from the verified JWT's top-level
 * claims. After getUser() validates the token server-side, we read the
 * `aal` claim from the parsed payload — NOT from app_metadata or
 * user_metadata which can be influenced by the user via profile updates.
 */
export function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const payloadB64 = parts[1];
  if (!payloadB64) return null;

  // Reject non-base64url characters
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64)) return null;

  // Size-bound the decode
  if (payloadB64.length > MAX_JWT_PAYLOAD_BYTES) return null;

  let decoded: string;
  try {
    // Add padding
    const padded = payloadB64.padEnd(payloadB64.length + ((4 - (payloadB64.length % 4)) % 4), '=');
    decoded = Buffer.from(padded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  // Must be valid JSON and an object at the top level
  try {
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Derive AAL from the JWT payload's top-level `aal` claim.
 * Only accepts 'aal1' or 'aal2'. Anything else (missing, null, wrong type,
 * unknown string) → 'aal1' (fail safe).
 */
export function deriveAalFromJwt(token: string): string {
  const payload = parseJwtPayload(token);
  if (!payload) return 'aal1';

  const aal = payload.aal;
  if (aal === 'aal2') return 'aal2';
  // aal1 (or anything else) defaults to aal1
  return 'aal1';
}

// ── User info extraction from Supabase Auth response ────────────────

/**
 * Extract application-level user info from a Supabase Auth user response.
 *
 * AAL is derived from the validated JWT's top-level `aal` claim via
 * parseJwtPayload, NOT from app_metadata/user_metadata.
 *
 * `appRole`, `orgId`, and `active` are read from `app_metadata` which
 * is set server-side by the application (not user-influenceable via
 * normal profile APIs).
 */
function extractAuthUser(
  authUser: Record<string, unknown>,
  aal: string,
): AuthUser {
  const appMetadata = (authUser.app_metadata as Record<string, unknown>) ?? {};
  const userMetadata = (authUser.user_metadata as Record<string, unknown>) ?? {};

  const appRole: 'admin' | 'interviewer' | 'viewer' =
    (appMetadata.app_role as 'admin' | 'interviewer' | 'viewer') ??
    'viewer';

  const orgId: string | null =
    (appMetadata.org_id as string) ?? null;

  const isActive: boolean =
    (appMetadata.active as boolean) ?? true;

  // Access gate input: only Supabase-confirmed emails pass the allowlist
  // gate. OAuth `hd` is a hint only — never authorization.
  const emailVerified: boolean =
    (authUser.email_confirmed_at as string | null) != null;

  return {
    id: String(authUser.id ?? ''),
    email: (authUser.email as string) ?? null,
    aal,
    active: isActive,
    appRole,
    orgId,
    emailVerified,
  };
}

// ── Supabase Auth verification (injectable test seam) ────────────────

/**
 * Default getUser implementation: calls Supabase Auth's getUser(jwt).
 */
export function defaultGetUser(supabase: SupabaseClient): TokenVerifier {
  return async (token: string) => {
    return (supabase.auth as any).getUser(token) as Promise<{
      data: { user: Record<string, unknown> | null };
      error: { message: string } | null;
    }>;
  };
}

/**
 * Verify a bearer token against Supabase Auth.
 *
 * Injectable deps allows tests to mock Supabase Auth without a live provider.
 * The `getUser` function receives a JWT string and returns the expected shape.
 *
 * AAL is derived from the JWT payload's top-level `aal` claim after
 * Supabase Auth has verified the token signature server-side.
 */
export async function verifyToken(
  token: string,
  deps: {
    getUser?: TokenVerifier;
  } = {},
): Promise<AuthResult> {
  const getUser =
    deps.getUser ??
    (async (t: string) => {
      const client = getClient();
      return (client.auth as any).getUser(t) as Promise<{
        data: { user: Record<string, unknown> | null };
        error: { message: string } | null;
      }>;
    });

  let result: { data: { user: Record<string, unknown> | null }; error: { message: string } | null };
  try {
    result = await getUser(token);
  } catch {
    return { ok: false, status: 401, message: 'Token verification unavailable' };
  }

  if (result.error || !result.data?.user) {
    return { ok: false, status: 401, message: 'Invalid or expired token' };
  }

  // CRITICAL: Derive AAL from the JWT payload's top-level `aal` claim,
  // NOT from app_metadata or user_metadata which are user-influenceable.
  const aal = deriveAalFromJwt(token);

  const user = extractAuthUser(result.data.user, aal);

  // AAL2 enforcement for privileged roles
  if ((user.appRole === 'admin' || user.appRole === 'interviewer') && user.aal !== 'aal2') {
    return { ok: false, status: 403, message: 'Multi-factor authentication required' };
  }

  // Active membership check
  if (!user.active) {
    return { ok: false, status: 403, message: 'Account is not active' };
  }

  return { ok: true, user };
}

// ── Express middleware ───────────────────────────────────────────────

/**
 * Express request augmentation.
 */
declare global {
  namespace Express {
    interface Request {
      /** Authenticated user, set by requireAuth middleware. */
      authUser?: AuthUser;
    }
  }
}

/**
 * Full authorization result: verified token + allowlist access + membership.
 */
export type FullAuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; status: 401 | 403; message: string };

/**
 * SINGLE shared full-authorization seam: bearer token → verified Supabase
 * email → allowlist/domain access resolver → server-held role → AAL gate.
 *
 * Used by BOTH the global requireAuth middleware and the livekit in-route
 * recruiter auth — there is deliberately NO weaker duplicate implementation.
 *
 *   - injected resolveAccess: the caller fully controls the access decision;
 *   - injected getUser only (legacy seam): the injected verifier encodes the
 *     server state (app_metadata) — unchanged pre-allowlist behavior;
 *   - live (no deps): defaultAccessResolver → resolve_allowlist_access RPC,
 *     which runs on EVERY request and denies inactive/missing/domain-
 *     mismatched/relinked entries even with a valid old JWT or a stale
 *     active membership row.
 *
 * Every failure path is a uniform generic 401/403 (never 500); resolver
 * errors fail closed (403).
 */
export async function resolveFullAuth(
  token: string,
  deps: {
    getUser?: TokenVerifier;
    resolveMembership?: MembershipResolver;
    resolveAccess?: AccessResolver;
  } = {},
): Promise<FullAuthResult> {
  const result = await verifyToken(token, deps);
  if (!result.ok) return result;

  let access: AccessResolution;
  try {
    access = deps.resolveAccess
      ? await deps.resolveAccess(result.user.id, result.user.email ?? '', result.user.emailVerified ?? false)
      : deps.getUser
        ? {
            // Legacy injected seam: role/active come from the injected
            // verifier (app_metadata) exactly as before the allowlist.
            ok: true,
            role: result.user.appRole,
            active: result.user.active,
          }
        : await defaultAccessResolver(
            result.user.id,
            result.user.email ?? '',
            result.user.emailVerified ?? false,
          );
  } catch {
    // Resolver failure fails closed — never 500, never silently grants.
    return { ok: false, status: 403, message: 'Insufficient permissions' };
  }
  if (!access.ok) {
    // Uniform generic 403 — never distinguishes wrong-domain from
    // not-allowlisted/disabled/missing.
    return { ok: false, status: 403, message: 'Insufficient permissions' };
  }

  // Membership mirrors the SERVER-HELD role (the resolver RPC just
  // upserted recruiter_memberships), or the injected resolver when one is
  // provided. Never the client.
  let membership: { role: 'admin' | 'interviewer' | 'viewer'; active: boolean } | null;
  try {
    membership = deps.resolveMembership
      ? await deps.resolveMembership(result.user.id)
      : { role: access.role, active: access.active };
  } catch {
    return { ok: false, status: 403, message: 'Insufficient permissions' };
  }
  if (!membership || !membership.active) {
    return { ok: false, status: 403, message: 'Insufficient permissions' };
  }
  if ((membership.role === 'admin' || membership.role === 'interviewer') && result.user.aal !== 'aal2') {
    return { ok: false, status: 403, message: 'Multi-factor authentication required' };
  }

  return {
    ok: true,
    user: {
      ...result.user,
      active: true,
      appRole: membership.role,
    },
  };
}

/**
 * Factory: creates a requireAuth middleware with optional injected deps.
 * When authDeps is provided, its getUser is used instead of the live
 * Supabase Auth client — enabling DI test seams without live provider.
 *
 * The middleware is a thin adapter over resolveFullAuth (the single shared
 * full-authorization seam) — same token → verified email → allowlist
 * resolver → role/AAL path as every other authenticated surface.
 */
export function createRequireAuth(authDeps?: {
  getUser?: TokenVerifier;
  resolveMembership?: MembershipResolver;
  resolveAccess?: AccessResolver;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers.authorization;
    const token = extractBearerToken(raw);

    if (!token) {
      res.status(401).json(authErrorBody(401));
      return;
    }

    resolveFullAuth(token, authDeps ?? {})
      .then((result) => {
        if (!result.ok) {
          res.status(result.status).json(authErrorBody(result.status));
          return;
        }
        req.authUser = result.user;
        next();
      })
      .catch(() => {
        // Safety net only — resolveFullAuth never rejects for auth paths.
        res.status(401).json(authErrorBody(401));
      });
  };
}

/** Default requireAuth using live Supabase client. */
export const requireAuth = createRequireAuth();

// ── Public route allowlist helper ────────────────────────────────────

/**
 * Pattern-based route allowlist. Matches method + path patterns.
 * Used to skip auth middleware for enumerated public endpoints.
 */
export const PUBLIC_ROUTES: { method: string; path: string }[] = [
  { method: 'GET', path: '/api/health' },
  { method: 'POST', path: '/api/csp-report' },
  // Each route below performs its own candidate-grant or worker authentication.
  { method: 'POST', path: '/api/livekit/exchange' },
  { method: 'POST', path: '/api/livekit/worker-context' },
  { method: 'POST', path: '/api/livekit/grant/recording' },
  // Phase 9 L4: exact public allowlist entries. Each public candidate route
  // validates its invite/appeal token inline BEFORE any DB write. /api/me and
  // all recruiter/admin routes remain authenticated (NOT added here).
  { method: 'GET', path: '/api/status' },
  { method: 'GET', path: '/api/candidate-consent/template' },
  { method: 'POST', path: '/api/candidate-consent/status' },
  { method: 'POST', path: '/api/candidate-consent/submit' },
  { method: 'POST', path: '/api/appeals' },
];

export function isPublicRoute(method: string, path: string): boolean {
  if (PUBLIC_ROUTES.some((r) => r.method === method && r.path === path)) return true;
  // Candidate recording upload is grant-authenticated inside the route.
  return method === 'POST' && /^\/api\/livekit\/[0-9a-f-]{36}\/recording$/i.test(path);
}

// ── Test helper: create a token verifier that always returns a given user ──

/**
 * Create a mock getUser that returns a fixed AuthUser for testing.
 */
export function mockAuthGetUser(user: AuthUser, token: string): TokenVerifier {
  const expectedPayload = parseJwtPayload(token);
  const aal = expectedPayload?.aal === 'aal2' ? 'aal2' : user.aal;

  return async (t: string) => {
    if (t !== token) {
      return { data: { user: null }, error: { message: 'Token mismatch' } };
    }
    return {
      data: {
        user: {
          id: user.id,
          email: user.email,
          app_metadata: {
            app_role: user.appRole,
            org_id: user.orgId,
            active: user.active,
          },
        },
      },
      error: null,
    };
  };
}
