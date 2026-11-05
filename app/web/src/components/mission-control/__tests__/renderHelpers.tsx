/**
 * Shared render/stub helpers for Mission Control tests (excluded from
 * coverage via the vitest __tests__ exclusion).
 */
import {
  stubMatchMedia,
  stubResizeObserver,
  stubCanvasContext,
  allowEchartsInitWarnings,
} from '../../design/__tests__/helpers';

/**
 * Stub the jsdom gaps charts need (same setup as DashboardPage.test).
 */
export function chartStubs() {
  stubResizeObserver();
  stubCanvasContext();
  stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
  allowEchartsInitWarnings();
}

