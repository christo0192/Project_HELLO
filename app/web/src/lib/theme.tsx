/**
 * Class-based, persisted theme system for HELLO.
 *
 * - `class` strategy: toggles `.dark` on `document.documentElement`
 *   (consumed by tailwind `darkMode: 'class'` and the CSS tokens in
 *   index.css).
 * - `system` mode: resolves from `prefers-color-scheme` and follows OS
 *   changes live.
 * - persisted: the chosen mode is stored in localStorage under
 *   `hello.theme` — the same key used by the pre-paint bootstrap script in
 *   index.html (kept in sync here; change both together).
 *
 * Charts, surfaces and text all derive from the resolved `theme` via
 * `useTheme()`. Charts require this provider; `useTheme()` throws outside it
 * so mis-wiring fails loudly instead of rendering a half-themed dashboard.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';
export type ThemeMode = Theme | 'system';

export const THEME_STORAGE_KEY = 'hello.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeContextValue {
  /** Resolved theme (mode === 'system' → OS preference). */
  theme: Theme;
  /** Chosen mode ('light' | 'dark' | 'system'). */
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* storage unavailable — default to system */
  }
  return 'system';
}

function readSystemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemPref, setSystemPref] = useState<Theme>(readSystemTheme);

  // Follow OS preference changes while in system mode.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) =>
      setSystemPref(event.matches ? 'dark' : 'light');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const theme: Theme = mode === 'system' ? systemPref : mode;

  // Apply the class + color-scheme to <html>.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
  }, [theme]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  }, []);

  const toggle = useCallback(() => {
    setMode(theme === 'dark' ? 'light' : 'dark');
  }, [setMode, theme]);

  const value = useMemo(
    () => ({ theme, mode, setMode, toggle }),
    [theme, mode, setMode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within <ThemeProvider>');
  }
  return context;
}
