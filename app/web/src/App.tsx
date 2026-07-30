import {
  Navigate,
  Route,
  BrowserRouter as Router,
  Routes,
} from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { MfaEnrollPage } from './pages/MfaEnrollPage';
import { MfaChallengePage } from './pages/MfaChallengePage';
import { UnauthorizedPage } from './pages/UnauthorizedPage';
import { CandidateJoinPage } from './pages/CandidateJoinPage';
import { RolesPage } from './pages/RolesPage';
import { CandidatesPage } from './pages/CandidatesPage';
import { CandidateDetailPage } from './pages/CandidateDetailPage';
import { ScreeningPage } from './pages/ScreeningPage';

export default function App() {
  return (
    <Router>
      <Routes>
        {/* Public auth routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mfa/enroll" element={<MfaEnrollPage />} />
        <Route path="/mfa/challenge" element={<MfaChallengePage />} />
        <Route path="/unauthorized" element={<UnauthorizedPage />} />
        <Route path="/candidate/join" element={<CandidateJoinPage />} />

        {/* Protected recruiter routes — AAL2 required */}
        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/candidates" replace />} />
            <Route path="/roles" element={<RolesPage />} />
            <Route path="/candidates" element={<CandidatesPage />} />
            <Route path="/candidates/:id" element={<CandidateDetailPage />} />
            <Route path="/screening/:sessionId" element={<ScreeningPage />} />
            <Route path="*" element={<Navigate to="/candidates" replace />} />
          </Route>
        </Route>

        {/* Catch-all — unknown routes redirect to login */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Router>
  );
}
