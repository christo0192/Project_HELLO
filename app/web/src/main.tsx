import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from './lib/auth.tsx';
import { ThemeProvider } from './lib/theme.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
     * ThemeProvider remains the chart context boundary. Production uses the
     * approved single light-first palette; the compatibility mode is retained
     * only for isolated legacy tests and future theme work.
     */}
    <ThemeProvider lightOnly>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
