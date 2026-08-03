/**
 * Shared render/stub helpers for Mission Control tests (excluded from
 * coverage via the vitest __tests__ exclusion).
 */
import type { ReactNode } from 'react';
import { ThemeProvider } from '../../../lib/theme';
import {
  stubMatchMedia,
  stubResizeObserver,
  stubCanvasContext,
  allowEchartsInitWarnings,
} from '../../design/__tests__/helpers';

/** Wrap in the theme provider (charts + KPI count-up need it). */
export function wrapTheme(ui: ReactNode): ReactNode {
  return <ThemeProvider>{ui}</ThemeProvider>;
}

/**
 * Stub the jsdom gaps charts need, with reduced motion enabled so KPI
 * count-ups render targets instantly (same setup as DashboardPage.test).
 */
export function chartStubs() {
  stubResizeObserver();
  stubCanvasContext();
  stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
  allowEchartsInitWarnings();
}

/** Dark-theme render helpers: force stored dark mode before rendering. */
export function forceDarkMode() {
  try {
    window.localStorage.setItem('hello.theme', 'dark');
  } catch {
    /* storage unavailable */
  }
}

export function forceLightMode() {
  try {
    window.localStorage.removeItem('hello.theme');
  } catch {
    /* storage unavailable */
  }
}
