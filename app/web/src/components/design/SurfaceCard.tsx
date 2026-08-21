/**
 * SurfaceCard — the candidate-scoped card primitive.
 *
 * Two levels, and only two. The scorecard the owner flagged nested tinted
 * blocks three deep inside a bordered card, every level painted the same
 * fill, so "inside" and "beside" were indistinguishable. Depth here
 * is therefore both *visual* (a bordered surface vs. a sunken well) and
 * *enforced*: a third nesting level throws instead of quietly rendering.
 *
 *   level="base"    bordered white surface — a real card
 *   level="sunken"  tinted well with no border — a block INSIDE a card
 *
 * Colour comes only from `--c-*`, which resolve solely under
 * `.candidate-scope` (see src/styles/candidate-palette.css).
 */

import { createContext, useContext } from 'react';
import type { ElementType, ReactNode } from 'react';
import { cx } from './cx';

export type SurfaceLevel = 'base' | 'sunken';

/** Nesting depth of the enclosing SurfaceCards. 0 = not inside one. */
const SurfaceDepthContext = createContext(0);

export const MAX_SURFACE_DEPTH = 2;

const levelStyles: Record<SurfaceLevel, string> = {
  base: 'rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)]',
  sunken: 'rounded-lg bg-[var(--c-border-light)]',
};

export interface SurfaceCardProps {
  level?: SurfaceLevel;
  /** Element to render. `section` gets a real accessible name via `label`. */
  as?: ElementType;
  /** Accessible name — applied as aria-label when `labelledBy` is absent. */
  label?: string;
  /** Id of the visible heading that names this region. */
  labelledBy?: string;
  className?: string;
  children: ReactNode;
  id?: string;
}

export function SurfaceCard({
  level = 'base',
  as,
  label,
  labelledBy,
  className,
  children,
  id,
}: SurfaceCardProps) {
  const depth = useContext(SurfaceDepthContext);
  const nextDepth = depth + 1;

  if (nextDepth > MAX_SURFACE_DEPTH && import.meta.env.DEV) {
    // Loud in development and in tests, where a composition mistake should
    // stop the build. NEVER in production: this invariant is about visual
    // hierarchy, and blanking a recruiter's candidate page over it would be
    // a far worse outcome than one card too many. There the depth is simply
    // clamped, so the extra level renders as the sunken level it already is.
    throw new Error(
      `SurfaceCard nested ${nextDepth} levels deep; the candidate experience allows at most ${MAX_SURFACE_DEPTH}.`,
    );
  }

  const Component = (as ?? 'div') as ElementType;
  const clampedDepth = Math.min(nextDepth, MAX_SURFACE_DEPTH);
  const effectiveLevel: SurfaceLevel = nextDepth > MAX_SURFACE_DEPTH ? 'sunken' : level;

  return (
    <SurfaceDepthContext.Provider value={clampedDepth}>
      <Component
        id={id}
        className={cx(levelStyles[effectiveLevel], className)}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        data-surface-level={effectiveLevel}
        data-surface-depth={clampedDepth}
      >
        {children}
      </Component>
    </SurfaceDepthContext.Provider>
  );
}
