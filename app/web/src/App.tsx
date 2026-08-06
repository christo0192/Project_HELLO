/**
 * HELLO application routes (integration lane).
 *
 * - Lazy route chunks: Dashboard, Candidate detail, Session detail and
 *   Mission Control are `React.lazy` so ECharts/motion-heavy code is split
 *   out of the main bundle; `<Suspense>` lives inside Layout (per-route
 *   loading fallback).
 * - `/dashboard` is the primary TA/HR landing; `/admin` is a safe alias
 *   that redirects to `/mission-control`.
 * - Mission Control is admin-gated by `ProtectedRoute requireRole="admin"`
 *   (UX gate only — the server enforces authorization).
 * - All existing candidate / call / consent / appeal / login routes are
 *   preserved unchanged.
 */

import { lazy } from 'react';
import {
  Navigate,
  Route,
  BrowserRouter as Router,
  Routes,
} from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { useAuth } from './lib/auth';
import { LoginPage } from './pages/LoginPage';
import { UnauthorizedPage } from './pages/UnauthorizedPage';
import { CandidateJoinPage } from './pages/CandidateJoinPage';
import { PrivacyNoticePage } from './pages/PrivacyNoticePage';
import { RolesPage } from './pages/RolesPage';
import { CandidatesPage } from './pages/CandidatesPage';
import { ScreeningPage } from './pages/ScreeningPage';
import { StatusPage } from './pages/StatusPage';
import { AppealPage } from './pages/AppealPage';
import { NotFoundPage } from './pages/NotFoundPage';

/** Named-export wrapper for React.lazy (pages use named exports). */
function lazyPage<T extends { [K in string]: unknown }>(
  loader: () => Promise<T>,
  name: keyof T & string,
) {
  return lazy(async () => {
    const mod = await loader();
    return { default: mod[name] as () => React.ReactElement };
  });
}

const DashboardPage = lazyPage(() => import('./pages/DashboardPage'), 'DashboardPage');
const CandidateDetailPage = lazyPage(
  () => import('./pages/CandidateDetailPage'),
  'CandidateDetailPage',
);
const SessionDetailPage = lazyPage(
  () => import('./pages/SessionDetailPage'),
  'SessionDetailPage',
);
const MissionControlPage = lazyPage(
  () => import('./pages/MissionControlPage'),
  'MissionControlPage',
);

/**
 * Single catch-all: authenticated users return to the dashboard (the old
 * protected `*` → /candidates behavior, retargeted to the new landing);
 * unauthenticated users get a truthful branded 404 with sign-in escape.
 */
function CatchAll() {
  const { isLoading, isAuthenticated } = useAuth();
  if (isLoading) return null;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return <NotFoundPage />;
}

export default function App() {
  return (
    <Router>
      <Routes>
        {/* Public auth routes */}
        <Route path="/login" element={<LoginPage />} />
        {/*
          MFA retired (ADR-0011). Legacy /mfa/* links redirect to the root,
          which sends authenticated users to /dashboard and unauthenticated
          users to /login via ProtectedRoute. No redirect loop is possible:
          ProtectedRoute no longer navigates to /mfa/* under any state.
          MfaEnrollPage/MfaChallengePage are retained in the tree but
          unrouted, so reinstating a Supabase-managed factor is a localized
          change here plus the API gates.
        */}
        <Route path="/mfa/*" element={<Navigate to="/" replace />} />
        <Route path="/unauthorized" element={<UnauthorizedPage />} />
        <Route path="/privacy-notice" element={<PrivacyNoticePage />} />
        <Route path="/candidate/join" element={<CandidateJoinPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/appeal" element={<AppealPage />} />

        {/* Protected recruiter routes — valid session + resolved allowlist role */}
        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/roles" element={<RolesPage />} />
            <Route path="/candidates" element={<CandidatesPage />} />
            <Route path="/candidates/:id" element={<CandidateDetailPage />} />
            <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
            <Route path="/screening/:sessionId" element={<ScreeningPage />} />
          </Route>
        </Route>

        {/* Mission Control — admin-gated (UX only; APIs authoritative) */}
        <Route element={<ProtectedRoute requireRole="admin" />}>
          <Route element={<Layout />}>
            <Route path="/admin" element={<Navigate to="/mission-control" replace />} />
            <Route path="/mission-control" element={<MissionControlPage />} />
          </Route>
        </Route>

        {/* Catch-all — unknown routes */}
        <Route path="*" element={<CatchAll />} />
      </Routes>
    </Router>
  );
}
