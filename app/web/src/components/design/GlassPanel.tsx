/**
 * GlassPanel — the shell's card material.
 *
 * A frosted, translucent surface floating on the lit ground. Depth comes
 * from blur + shadow, so panels never nest: inside a panel use
 * `level="sunken"` wells (a tinted, borderless block) or plain rows.
 *
 * No motion import here on purpose — candidate-scoped files may render it.
 * Hover lift for `interactive` panels is CSS (`.glass-interactive`) and
 * collapses under `prefers-reduced-motion`.
 */
import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type GlassLevel = 'raised' | 'strong' | 'sunken';
export type GlassPadding = 'none' | 'sm' | 'md' | 'lg';

const levelClass: Record<GlassLevel, string> = {
  raised: 'glass',
  strong: 'glass-strong',
  sunken: 'glass-sunken',
};

const paddingClass: Record<GlassPadding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5 sm:p-6',
  lg: 'p-6 sm:p-8',
};

export interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  level?: GlassLevel;
  padding?: GlassPadding;
  /** Lifts on hover (links, drill-down cards). */
  interactive?: boolean;
  children: ReactNode;
}

export function GlassPanel({
  as,
  level = 'raised',
  padding = 'md',
  interactive = false,
  className,
  children,
  ...rest
}: GlassPanelProps) {
  const Component = (as ?? 'div') as ElementType;
  return (
    <Component
      className={cx(
        levelClass[level],
        paddingClass[padding],
        interactive && 'glass-interactive',
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}
