/**
 * Unit tests for the AuthProvider and useAuth hook.
 *
 * These tests mock the Supabase client entirely.  No real network calls.
 * Focus on the state machine: loading → signed out / signed in → AAL check.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthProvider, useAuth, getSsoProviders } from '../auth';

// ── Fixtures ──────────────────────────────────────────────────────────

const mockSession = {
  access_token: 'mock-access-token',
  refresh_token: 'mock-refresh-token',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user: {
    id: 'user-1',
    email: 'recruiter@example.com',
    aud: 'authenticated',
    role: 'authenticated',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    app_metadata: {},
    user_metadata: {},
    identities: [],
    factors: [],
  },
};

const mockAal1Result = {
  data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: ['password'] },
  error: null,
};

const mockAal2Result = {
  data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: ['password', 'totp'] },
  error: null,
};

const mockFactorsNone = {
  data: { all: [], totp: [], phone: [] },
  error: null,
};

const mockFactorVerified = {
  id: 'factor-1',
  type: 'totp',
  factor_type: 'totp',
  status: 'verified',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  friendly_name: 'Auth App',
};

// ── Mock Supabase ─────────────────────────────────────────────────────

let mockSupabase: any;

vi.mock('../supabase', () => ({
  supabase: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'auth') return mockSupabase?.auth;
        return undefined;
      },
    },
  ),
}));

// Phase 9 L4: AuthProvider loads the authoritative role from /api/me after
// an AAL2 session. The api module must be mocked so no real fetch happens.
// Path is relative to this test file (src/lib/__tests__) → src/api.ts.
const { getMe } = vi.hoisted(() => ({ getMe: vi.fn() }));
vi.mock('../../api', () => ({
  api: { getMe },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

function setupMockSupabase() {
  mockSupabase = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
      signInWithPassword: vi.fn(),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      signInWithOAuth: vi.fn(),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue(mockAal1Result),
        listFactors: vi.fn().mockResolvedValue(mockFactorsNone),
        enroll: vi.fn(),
        challengeAndVerify: vi.fn(),
      },
    },
  };
}

// ── Test consumer component ────────────────────────────────────────────

function TestConsumer() {
  const {
    user,
    session,
    aal,
    isLoading,
    isAuthenticated,
    needsMfa,
    role,
    signIn,
    signOut,
    enrollMfa,
    challengeMfa,
    signInWithSSO,
  } = useAuth();

  if (isLoading) return <div data-testid="loading">Loading…</div>;

  return (
    <div>
      <div data-testid="session">{session ? 'present' : 'absent'}</div>
      <div data-testid="user-email">{user?.email ?? 'none'}</div>
      <div data-testid="aal">{aal ?? 'null'}</div>
      <div data-testid="authenticated">{isAuthenticated ? 'yes' : 'no'}</div>
      <div data-testid="needs-mfa">{needsMfa ? 'yes' : 'no'}</div>
      <div data-testid="role">{role ?? 'null'}</div>

      <button
        data-testid="sign-in-btn"
        onClick={() => signIn('test@test.com', 'password')}
      >
        Sign In
      </button>
      <button data-testid="sign-out-btn" onClick={signOut}>
        Sign Out
      </button>
      <button
        data-testid="enroll-btn"
        onClick={() => enrollMfa()}
      >
        Enroll
      </button>
      <button
        data-testid="challenge-btn"
        onClick={() => challengeMfa('123456')}
      >
        Challenge
      </button>
      <button
        data-testid="sso-btn"
        onClick={() => signInWithSSO('google')}
      >
        SSO
      </button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <AuthProvider>
      <TestConsumer />
    </AuthProvider>,
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    setupMockSupabase();
    vi.clearAllMocks();
    getMe.mockResolvedValue({ userId: 'user-1', email: 'recruiter@example.com', role: 'admin', active: true });
  });

  it('shows loading state initially, then transitions to no session', async () => {
    renderWithProvider();
    expect(screen.getByTestId('loading')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('session')).toHaveTextContent('absent');
    });
  });

  it('restores session on mount', async () => {
    mockSupabase.auth.getSession = vi
      .fn()
      .mockResolvedValue({ data: { session: mockSession }, error: null });
    mockSupabase.auth.mfa.getAuthenticatorAssuranceLevel = vi
      .fn()
      .mockResolvedValue(mockAal1Result);

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('user-email')).toHaveTextContent(
        'recruiter@example.com',
      );
      expect(screen.getByTestId('aal')).toHaveTextContent('aal1');
      expect(screen.getByTestId('needs-mfa')).toHaveTextContent('yes');
      expect(screen.getByTestId('authenticated')).toHaveTextContent('no');
    });
  });

  it('detects AAL2 session', async () => {
    mockSupabase.auth.getSession = vi
      .fn()
      .mockResolvedValue({ data: { session: mockSession }, error: null });
    mockSupabase.auth.mfa.getAuthenticatorAssuranceLevel = vi
      .fn()
      .mockResolvedValue(mockAal2Result);
    mockSupabase.auth.mfa.listFactors = vi.fn().mockResolvedValue({
      data: { all: [mockFactorVerified], totp: [mockFactorVerified], phone: [] },
      error: null,
    });

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('aal')).toHaveTextContent('aal2');
      expect(screen.getByTestId('authenticated')).toHaveTextContent('yes');
      expect(screen.getByTestId('needs-mfa')).toHaveTextContent('no');
    });
    // Authoritative role comes from /api/me, not app_metadata.
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('admin'));
    expect(getMe).toHaveBeenCalled();
  });

  it('fails closed (role null) when /api/me cannot be loaded', async () => {
    mockSupabase.auth.getSession = vi
      .fn()
      .mockResolvedValue({ data: { session: mockSession }, error: null });
    mockSupabase.auth.mfa.getAuthenticatorAssuranceLevel = vi
      .fn()
      .mockResolvedValue(mockAal2Result);
    mockSupabase.auth.mfa.listFactors = vi.fn().mockResolvedValue({
      data: { all: [mockFactorVerified], totp: [mockFactorVerified], phone: [] },
      error: null,
    });
    getMe.mockRejectedValue(new Error('api down'));

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('aal')).toHaveTextContent('aal2'));
    await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('null'));
  });

  it('signs in and updates state', async () => {
    // Initial state: no session
    mockSupabase.auth.getSession = vi
      .fn()
      .mockResolvedValue({ data: { session: null }, error: null });

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('session')).toHaveTextContent('absent');
    });

    // After click, signIn triggers getSession which now returns session
    mockSupabase.auth.signInWithPassword = vi.fn().mockResolvedValue({
      data: { session: mockSession, user: mockSession.user },
      error: null,
    });
    mockSupabase.auth.getSession = vi
      .fn()
      .mockResolvedValue({ data: { session: mockSession }, error: null });
    mockSupabase.auth.mfa.getAuthenticatorAssuranceLevel = vi
      .fn()
      .mockResolvedValue(mockAal1Result);

    await userEvent.click(screen.getByTestId('sign-in-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('user-email')).toHaveTextContent(
        'recruiter@example.com',
      );
    });
  });

  it('signs out and clears state', async () => {
    mockSupabase.auth.getSession = vi
      .fn()
      .mockResolvedValue({ data: { session: mockSession }, error: null });
    mockSupabase.auth.mfa.getAuthenticatorAssuranceLevel = vi
      .fn()
      .mockResolvedValue(mockAal1Result);

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('session')).toHaveTextContent('present');
    });

    await userEvent.click(screen.getByTestId('sign-out-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('session')).toHaveTextContent('absent');
      expect(screen.getByTestId('aal')).toHaveTextContent('null');
    });
  });

  it('calls enrollMfa', async () => {
    mockSupabase.auth.mfa.enroll = vi.fn().mockResolvedValue({
      data: { id: 'factor-new', type: 'totp', totp: { secret: 'SECRET123', uri: 'otpauth://totp/test' } },
      error: null,
    });

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('session')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('enroll-btn'));
    await waitFor(() => {
      expect(mockSupabase.auth.mfa.enroll).toHaveBeenCalledWith({
        factorType: 'totp',
      });
    });
  });

  it('calls challengeMfa which uses challengeAndVerify', async () => {
    mockSupabase.auth.mfa.challengeAndVerify = vi.fn().mockResolvedValue({
      data: { id: 'verify-ok' },
      error: null,
    });
    mockSupabase.auth.mfa.listFactors = vi.fn().mockResolvedValue({
      data: {
        all: [mockFactorVerified],
        totp: [mockFactorVerified],
        phone: [],
      },
      error: null,
    });

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('session')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('challenge-btn'));
    await waitFor(() => {
      expect(mockSupabase.auth.mfa.challengeAndVerify).toHaveBeenCalled();
    });
  });

  it('handles signInWithSSO for allowed providers', async () => {
    // Set env var
    import.meta.env.VITE_SSO_PROVIDERS = 'google,github';
    mockSupabase.auth.signInWithOAuth = vi
      .fn()
      .mockResolvedValue({ data: {}, error: null });

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('session')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('sso-btn'));
    await waitFor(() => {
      expect(mockSupabase.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
    });

    // Cleanup
    delete import.meta.env.VITE_SSO_PROVIDERS;
  });
});

describe('getSsoProviders', () => {
  it('returns empty array when env var is not set', () => {
    delete import.meta.env.VITE_SSO_PROVIDERS;
    expect(getSsoProviders()).toEqual([]);
  });

  it('parses comma-separated providers', () => {
    import.meta.env.VITE_SSO_PROVIDERS = 'google, github, microsoft';
    expect(getSsoProviders()).toEqual(['google', 'github', 'microsoft']);
  });

  it('returns empty array for empty string', () => {
    import.meta.env.VITE_SSO_PROVIDERS = '';
    expect(getSsoProviders()).toEqual([]);
  });

  it('trims whitespace and lowercases', () => {
    import.meta.env.VITE_SSO_PROVIDERS = '  Google , GITHub  ';
    expect(getSsoProviders()).toEqual(['google', 'github']);
  });

  afterEach(() => {
    delete import.meta.env.VITE_SSO_PROVIDERS;
  });
});

describe('useAuth throws outside provider', () => {
  it('throws error when used without AuthProvider', () => {
    // Suppress expected error
    (globalThis as any).__allowConsole?.(/useAuth must be used within an AuthProvider/);

    function BadComponent() {
      useAuth();
      return null;
    }

    expect(() => render(<BadComponent />)).toThrow(
      'useAuth must be used within an AuthProvider',
    );
  });
});
