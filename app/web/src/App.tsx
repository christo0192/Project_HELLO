import {
  Navigate,
  Route,
  BrowserRouter as Router,
  Routes,
} from "react-router-dom";
import { Layout } from "./components/Layout";
import { RolesPage } from "./pages/RolesPage";
import { CandidatesPage } from "./pages/CandidatesPage";
import { CandidateDetailPage } from "./pages/CandidateDetailPage";
import { ScreeningPage } from "./pages/ScreeningPage";

export default function App() {
  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/candidates" replace />} />
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/candidates" element={<CandidatesPage />} />
          <Route path="/candidates/:id" element={<CandidateDetailPage />} />
          <Route path="/screening/:sessionId" element={<ScreeningPage />} />
          <Route path="*" element={<Navigate to="/candidates" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
