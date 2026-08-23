/**
 * True while the viewport is narrow enough that a seven-column grid stops
 * being readable.
 *
 * The breakpoint matches Tailwind's `sm` (640px), so the JS default and the
 * CSS layout change at the same width rather than at two widths that drift
 * apart.
 *
 * `matchMedia` is absent in some environments (jsdom does not implement it
 * unless a test installs it). Absence is treated as "not narrow" rather than
 * as an error: the grid is the richer view, and a missing capability should
 * not silently downgrade what an operator sees.
 */

import { useEffect, useState } from 'react';

export const NARROW_VIEWPORT_QUERY = '(max-width: 639px)';

function readMatch(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(readMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const list = window.matchMedia(NARROW_VIEWPORT_QUERY);
    // Re-read on mount: the media state can have changed between the initial
    // render and the effect, and between a server render and hydration.
    setNarrow(list.matches);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    }
    // Safari < 14 and some test doubles only expose the deprecated pair.
    list.addListener(onChange);
    return () => list.removeListener(onChange);
  }, []);

  return narrow;
}
