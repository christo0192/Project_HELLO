/**
 * Shared test stubs for theme / motion / chart tests (jsdom gaps).
 * Excluded from coverage via the vitest config test-excludes.
 */
import { vi } from 'vitest';

type MediaListener = (event: { matches: boolean; media: string }) => void;

export interface MatchMediaStub {
  matches: boolean;
  media: string;
  listeners: MediaListener[];
  setMatches: (matches: boolean) => void;
}

/** Stub `window.matchMedia`; `setMatches` fires change listeners. */
export function stubMatchMedia(
  matches = false,
  media = '(prefers-color-scheme: dark)',
): MatchMediaStub {
  const stub: MatchMediaStub = {
    matches,
    media,
    listeners: [],
    setMatches(m) {
      stub.matches = m;
      stub.listeners.forEach((listener) => listener({ matches: m, media: stub.media }));
    },
  };
  const mql = {
    get matches() {
      return stub.matches;
    },
    get media() {
      return stub.media;
    },
    addEventListener: (_type: string, listener: MediaListener) => {
      stub.listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: MediaListener) => {
      stub.listeners = stub.listeners.filter((l) => l !== listener);
    },
    addListener: (listener: MediaListener) => {
      stub.listeners.push(listener);
    },
    removeListener: (listener: MediaListener) => {
      stub.listeners = stub.listeners.filter((l) => l !== listener);
    },
    dispatchEvent: () => true,
    onchange: null,
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return stub;
}

/** jsdom lacks ResizeObserver — echarts-for-react's size-sensor needs it. */
export function stubResizeObserver(): void {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
}

/** Silence jsdom "Not implemented: HTMLCanvasElement.prototype.getContext". */
export function stubCanvasContext(): void {
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, prop) {
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'canvas') return null;
      return () => undefined;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
}

/** ECharts warns when the jsdom container has no layout (clientWidth 0). */
export function allowEchartsInitWarnings(): void {
  (globalThis as any).__allowConsole(/width or height/);
}
