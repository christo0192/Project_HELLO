/**
 * Auth context, provider, and hooks for the recruiter dashboard.
 *
 * Provides:
 *   - Email/password sign-in via Supabase
 *   - Session restoration on page load via `getSession()`
 *   - AAL tracking via `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`
 *   - TOTP MFA enrollment and challenge (AAL1 → AAL2)
 *   - SSO OAuth initiation from an allowlisted provider env value
 *   - Session cleanup on 401 (via auth:unauthorized event)
 *   - Logout clears subscriptions and app state
 *
 * Public signup is NOT supported — only existing recruiter accounts.
 *
 * ── AAL (Authenticator Assurance Level) ───────────────────────────────
 *   - `aal1`: basic auth (email/password or OAuth)
 *   - `aal2`: MFA verified (TOTP factor verified)
 *
 * The `getAuthenticatorAssuranceLevel()` API checks the JWT's `aal` claim
 * AND the user's verified MFA factors.  After TOTP verification via
 * `mfa.verify()`, the session token is rotated with `aal2` in the JWT.
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
  /** True if the user has a session but needs MFA (AAL1). */
  needsMfa: boolean;
  /** True if the user has a session at AAL2 (fully authenticated). */
  isAuthenticated: boolean;
  /** Enrolled MFA factors (populated after sign-in). */
  factors: MfaFactor[];
  /**
   * Authoritative role from GET /api/me (membership resolver), loaded only
   * after an AAL2 session. Never derived from editable app_metadata. Null
   * while unresolved or when /api/me failed (fail closed).
   */
  role: MembershipRole | null;

  /** Sign in with email and password. */
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  /** Sign out — clears subscriptions and app state. */
  signOut: () => Promise<void>;
  /** Initiate SSO OAuth with a configured provider. */
  signInWithSSO: (provider: string) => Promise<void>;
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
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  const needsMfa = aal === 'aal1' && session !== null;
  const isAuthenticated = aal === 'aal2' && session !== null;

  /**
   * Load the authoritative role/active from GET /api/me after an AAL2
   * session. Never trusts editable app_metadata for role UX. Failures set
   * role to null (fail closed — ProtectedRoute shows a safe state).
   */
  const refreshRole = useCallback(async (): Promise<void> => {
    try {
      const me = await api.getMe();
      setRole(me.role);
    } catch {
      setRole(null);
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
      if (level === 'aal2') {
        await refreshRole();
      } else {
        setRole(null);
      }
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
  const signInWithSSO = useCallback(async (provider: string) => {
    const allowed = getSsoProviders();
    if (!allowed.includes(provider.toLowerCase())) {
      throw new Error('SSO provider is not configured or not allowed.');
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: provider as any,
      options: { redirectTo: window.location.origin },
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

        if (level === 'aal2') {
          try {
            const me = await api.getMe();
            if (!cancelled) setRole(me.role);
          } catch {
            if (!cancelled) setRole(null);
          }
        } else if (!cancelled) {
          setRole(null);
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
        if (subscriptionRef.current) {
          subscriptionRef.current.unsubscribe();
          subscriptionRef.current = null;
        }
        return;
      }

      // For SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED — refresh AAL
      if (currentSession) {
        getAalLevel().then((level) => {
          setAal(level);
          if (level === 'aal2') {
            refreshRole();
          } else {
            setRole(null);
          }
        });
        getVerifiedTotpFactors().then((verifiedFactors) => {
          setFactors(verifiedFactors);
        });
      } else {
        setRole(null);
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
