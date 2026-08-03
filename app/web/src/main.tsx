import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from './lib/auth.tsx';
import { ThemeProvider } from './lib/theme.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
     * ThemeProvider must mount BEFORE any page renders: charts (ECharts
     * palette) and ThemeToggle call useTheme(), which throws outside the
     * provider. The pre-paint bootstrap in index.html already applied the
     * persisted/system theme class; the provider takes over from here
     * (same `hello.theme` storage key — keep both in sync).
     */}
    <ThemeProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
