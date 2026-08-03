/**
 * Legend hover-dim interaction context.
 *
 * Adapted from bklit-ui `chart-legend-hover.tsx` (MIT, Copyright (c) 2026
 * uixmat) — see THIRD_PARTY_NOTICES.md. bklit dims non-hovered SVG series on
 * legend hover; here the same hovered-index contract drives ECharts
 * `highlight`/`downplay` actions so other slices dim.
 */
import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';

interface LegendHoverContextValue {
  hoveredIndex: number | null;
  setHoveredIndex: (index: number | null) => void;
}

const LegendHoverContext = createContext<LegendHoverContextValue | null>(null);

export function LegendHoverProvider({
  hoveredIndex,
  onHoverChange,
  children,
}: {
  hoveredIndex: number | null;
  onHoverChange: (index: number | null) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ hoveredIndex, setHoveredIndex: onHoverChange }),
    [hoveredIndex, onHoverChange],
  );
  return (
    <LegendHoverContext.Provider value={value}>{children}</LegendHoverContext.Provider>
  );
}

export function useLegendHover(): LegendHoverContextValue {
  const context = useContext(LegendHoverContext);
  return (
    context ?? {
      hoveredIndex: null,
      setHoveredIndex: () => {
        /* noop outside LegendHoverProvider */
      },
    }
  );
}
