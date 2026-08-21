/**
 * Auth context, provider, and hooks for the recruiter dashboard.
 *
 * Provides:
 *   - Email/password sign-in via Supabase
 *   - Session restoration on page load via `getSession()`
 *   - Google OAuth initiation from an allowlisted provider env value
 *   - Authoritative role resolution via GET /api/me
 *   - Session cleanup on 401 (via auth:unauthorized event)
 *   - Logout clears subscriptions and app state
 *
 * Public signup is NOT supported — only existing recruiter accounts.
 *
 * ── Authentication model (ADR-0011) ───────────────────────────────────
 * Single factor: NO MFA. A valid Supabase session authenticates the user;
 * authorization is an ACTIVE entry in the server-held email allowlist plus
 * the role held there, enforced by the API on every request. Nothing here
 * is authorization — the API is always authoritative.
 *
 * `aal` is still tracked for observability but is NOT an access input, and
 * `needsMfa` is retained as a constant `false` so consumers keep compiling.
 * Reinstating MFA means restoring the gate here AND in the API's
 * verifyToken()/resolveFullAuth() together, plus re-enabling enrollment in
 * Supabase config.
 *
 * ── Role resolution ──────────────────────────────────────────────────
 * `isRoleLoading` is true while GET /api/me is in flight. ProtectedRoute
 * must render a loading state (never children) while it is true, so no
 * recruiter/candidate data is shown before the role resolves. A resolved
 * `role === null` means /api/me failed or denied — fail closed.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AuthError, Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { api } from '../api';
import { AUTH_UNAUTHORIZED_EVENT } from './api-client';
import { sanitizeReturnTo } from './return-to';

/* ── Types ─────────────────────────────────────────────────────────── */

export type AAL = 'aal1' | 'aal2' | null;
export type MembershipRole = 'admin' | 'interviewer' | 'viewer';

export interface MfaFactor {
  id: string;
  type: 'totp';
}

export interface AuthState {
  /** Current Supabase session (null if not authenticated). */
  session: Session | null;
  /** Current user (null if not authenticated). */
  user: User | null;
  /** Authenticator Assurance Level — null before session is checked. */
  aal: AAL;
  /** True while initial session check or sign-in is in progress. */
  isLoading: boolean;
  /**
   * Always false — MFA was removed in ADR-0011. Retained so existing
   * consumers keep compiling; do not reintroduce a gate on this without
   * also restoring the API-side gates.
   */
  needsMfa: boolean;
  /** True if the user has a valid session (single factor — ADR-0011). */
  isAuthenticated: boolean;
  /** Enrolled MFA factors. Always empty in practice — enrollment disabled. */
  factors: MfaFactor[];
  /**
   * Authoritative role from GET /api/me (server-held allowlist role).
   * Never derived from editable app_metadata. Null while unresolved or when
   * /api/me failed/denied (fail closed).
   */
  role: MembershipRole | null;
  /**
   * True while GET /api/me is in flight. Guards against rendering any
   * recruiter/candidate data before the role resolves.
   */
  isRoleLoading: boolean;

  /** Sign in with email and password. */
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  /** Sign out — clears subscriptions and app state. */
  signOut: () => Promise<void>;
  /** Initiate SSO OAuth with a configured provider. */
  signInWithSSO: (provider: string, returnTo?: string) => Promise<void>;
  /** Enroll a TOTP MFA factor. */
  enrollMfa: () => Promise<{
    error: AuthError | null;
    factor?: MfaFactor;
    totpUri?: string;
    secret?: string;
  }>;
  /** Challenge an MFA factor with a TOTP code. */
  challengeMfa: (code: string) => Promise<{
    error: AuthError | null;
    verified: boolean;
  }>;
  /** Refresh the AAL, factors, and authoritative role after MFA verification. */
  refreshSession: () => Promise<void>;
}

/* ── Context ───────────────────────────────────────────────────────── */

const AuthContext = createContext<AuthState | null>(null);

/* ── SSO provider allowlist ────────────────────────────────────────── */

function getSsoProviders(): string[] {
  const raw = import.meta.env.VITE_SSO_PROVIDERS;
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* ── Company-email access gate (UX helpers — NEVER authorization) ─── */

/**
 * The ONLY accepted email domain for dashboard access (Google Workspace
 * company account). Enforced server-side by the allowlist resolver;
 * these helpers only drive login-page messaging.
 */
export const ALLOWED_EMAIL_DOMAIN = 'interviewkickstart.com';

/**
 * UX-only company-email check (never authorization — the API enforces the
 * allowlist with the verified Supabase email). Mirrors the server's strict
 * ASCII trim+lower normalization for inline hints: exactly one '@' and the
 * exact domain interviewkickstart.com.
 */
export function isCompanyEmail(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  // Strict ASCII — unicode lookalikes are never a company account.
  if (/[^\x20-\x7E]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  const angle = /^.*<([^<>]+)>$/.exec(lower);
  const email = (angle ? angle[1] : lower).trim();
  const at = email.indexOf('@');
  if (at === -1 || email.indexOf('@', at + 1) !== -1) return false;
  return email.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}

/* ── Helper: get AAL from getAuthenticatorAssuranceLevel ──────────── */

async function getAalLevel(): Promise<AAL> {
  try {
    const { data, error } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return null;
    return (data.currentLevel as AAL) ?? null;
  } catch {
    return null;
  }
}

/* ── Helper: list verified TOTP factors ──────────────────────────── */

async function getVerifiedTotpFactors(): Promise<MfaFactor[]> {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error || !data) return [];
    return (data.totp ?? [])
      .filter((f) => f.status === 'verified')
      .map((f) => ({ id: f.id, type: 'totp' as const }));
  } catch {
    return [];
  }
}

/* ── Provider ──────────────────────────────────────────────────────── */

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [aal, setAal] = useState<AAL>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [role, setRole] = useState<MembershipRole | null>(null);
  const [isRoleLoading, setIsRoleLoading] = useState(false);
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  // ADR-0011: single factor. A valid session authenticates; the API enforces
  // the active allowlist entry and role on every request.
  const needsMfa = false;
  const isAuthenticated = session !== null;

  /**
   * Load the authoritative role from GET /api/me (server-held allowlist
   * role). Never trusts editable app_metadata for role UX. Failures and
   * denials set role to null (fail closed — ProtectedRoute shows a safe
   * state). `isRoleLoading` brackets the request so no data renders first.
   */
  const refreshRole = useCallback(async (): Promise<void> => {
    setIsRoleLoading(true);
    try {
      const me = await api.getMe();
      setRole(me.role);
    } catch {
      setRole(null);
    } finally {
      setIsRoleLoading(false);
    }
  }, []);

  /* ── Refresh session, AAL, factors, and authoritative role ─────── */
  const refreshSession = useCallback(async () => {
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    setSession(currentSession);
    setUser(currentSession?.user ?? null);

    const level = await getAalLevel();
    setAal(level);

    if (currentSession) {
      const verifiedFactors = await getVerifiedTotpFactors();
      setFactors(verifiedFactors);
      // ADR-0011: role resolves for any valid session, not only aal2.
      await refreshRole();
    } else {
      setFactors([]);
      setRole(null);
    }
  }, [refreshRole]);

  /* ── Sign in ──────────────────────────────────────────────────── */
  const signIn = useCallback(
    async (email: string, password: string) => {
      setIsLoading(true);
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (!error) {
        await refreshSession();
      }
      setIsLoading(false);
      return { error };
    },
    [refreshSession],
  );

  /* ── SSO sign-in ──────────────────────────────────────────────── */
  const signInWithSSO = useCallback(async (provider: string, returnTo?: string) => {
    const allowed = getSsoProviders();
    if (!allowed.includes(provider.toLowerCase())) {
      throw new Error('SSO provider is not configured or not allowed.');
    }
    // The IdP round trip is a FULL-PAGE navigation, so router state is lost.
    // Ask the provider to come back on the deep link itself, re-validating the
    // path here against the same exact allowlist that guards every other
    // return-to — `sanitizeReturnTo` stays the single trust boundary, so no
    // caller can widen this into an open redirect. If the deployment has not
    // registered the path in Supabase's allowed redirect URLs, Supabase falls
    // back to the site URL and the parked sessionStorage copy takes over.
    const safeReturnTo = sanitizeReturnTo(returnTo);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: provider as any,
      options: { redirectTo: `${window.location.origin}${safeReturnTo ?? ''}` },
    });
    if (error) throw error;
  }, []);

  /* ── Logout ───────────────────────────────────────────────────── */
  const signOut = useCallback(async () => {
    // Unsubscribe Realtime subscriptions before clearing session.
    if (subscriptionRef.current) {
      subscriptionRef.current.unsubscribe();
      subscriptionRef.current = null;
    }

    // Clear app state: reset all state fields.
    setSession(null);
    setUser(null);
    setAal(null);
    setFactors([]);
    setRole(null);
    setIsLoading(false);

    await supabase.auth.signOut();
  }, []);

  /* ── TOTP enrollment ──────────────────────────────────────────── */
  const enrollMfa = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
      });
      if (error) return { error };
      return {
        error: null,
        factor: { id: data.id, type: 'totp' as const },
        totpUri: data.totp?.uri ?? data.totp?.qr_code,
        secret: data.totp?.secret,
      };
    } catch (e) {
      return { error: e as AuthError };
    }
  }, []);

  /* ── TOTP challenge & verify ──────────────────────────────────── */
  const challengeMfa = useCallback(
    async (code: string) => {
      try {
        // List factors to get verified TOTP factor ID
        const verifiedFactors = await getVerifiedTotpFactors();
        if (verifiedFactors.length === 0) {
          // No verified factor — try challengeAndVerify on any TOTP factor
          const { data: listData } = await supabase.auth.mfa.listFactors();
          const allTotp = (listData?.all ?? []).filter(
            (f) => f.factor_type === 'totp',
          );
          if (allTotp.length === 0) {
            return {
              error: new Error('No TOTP factor found. Enroll first.') as AuthError,
              verified: false,
            };
          }
          // Use challengeAndVerify for the first unverified TOTP factor
          // (enrollment verification flow)
          const { error: verifyError } =
            await supabase.auth.mfa.challengeAndVerify({
              factorId: allTotp[0].id,
              code,
            });
          if (verifyError) {
            return { error: verifyError, verified: false };
          }
          await refreshSession();
          return { error: null, verified: true };
        }

        // Use challengeAndVerify on a verified factor
        const { error: verifyError } =
          await supabase.auth.mfa.challengeAndVerify({
            factorId: verifiedFactors[0].id,
            code,
          });
        if (verifyError) {
          return { error: verifyError, verified: false };
        }

        // Refresh session to get updated AAL
        await refreshSession();
        return { error: null, verified: true };
      } catch (e) {
        return { error: e as AuthError, verified: false };
      }
    },
    [refreshSession],
  );

  /* ── Handle 401 unauthorized event ────────────────────────────── */
  useEffect(() => {
    const handler = () => {
      signOut();
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
  }, [signOut]);

  /* ── Initial session restoration ──────────────────────────────── */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const {
        data: { session: initialSession },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      setSession(initialSession);
      setUser(initialSession?.user ?? null);

      if (initialSession) {
        const level = await getAalLevel();
        if (!cancelled) setAal(level);

        const verifiedFactors = await getVerifiedTotpFactors();
        if (!cancelled) setFactors(verifiedFactors);

        // ADR-0011: role resolves for any valid session, not only aal2.
        if (!cancelled) setIsRoleLoading(true);
        try {
          const me = await api.getMe();
          if (!cancelled) setRole(me.role);
        } catch {
          if (!cancelled) setRole(null);
        } finally {
          if (!cancelled) setIsRoleLoading(false);
        }
      }

      if (!cancelled) setIsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Listen for auth state changes ────────────────────────────── */
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
      setUser(currentSession?.user ?? null);

      if (_event === 'SIGNED_OUT') {
        setAal(null);
        setFactors([]);
        setRole(null);
        setIsRoleLoading(false);
        if (subscriptionRef.current) {
          subscriptionRef.current.unsubscribe();
          subscriptionRef.current = null;
        }
        return;
      }

      // For SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED — refresh AAL
      if (currentSession) {
        // AAL tracked for observability only (ADR-0011).
        getAalLevel().then((level) => {
          setAal(level);
        });
        refreshRole();
        getVerifiedTotpFactors().then((verifiedFactors) => {
          setFactors(verifiedFactors);
        });
      } else {
        setRole(null);
        setIsRoleLoading(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [refreshRole]);

  /* ── Memoised context value ───────────────────────────────────── */
  const value = useMemo<AuthState>(
    () => ({
      session,
      user,
      aal,
      isLoading,
      needsMfa,
      isAuthenticated,
      factors,
      role,
      isRoleLoading,
      signIn,
      signOut,
      signInWithSSO,
      enrollMfa,
      challengeMfa,
      refreshSession,
    }),
    [
      session,
      user,
      aal,
      isLoading,
      needsMfa,
      isAuthenticated,
      factors,
      role,
      isRoleLoading,
      signIn,
      signOut,
      signInWithSSO,
      enrollMfa,
      challengeMfa,
      refreshSession,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* ── Hook ──────────────────────────────────────────────────────────── */

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

/* ── SSO provider allowlist (exported for tests) ──────────────────── */

export { getSsoProviders };
