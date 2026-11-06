/**
 * GlassPanel: the panel primitive. The name is historical; there is no glass.
 *
 * A printed box on the sheet: opaque paper, a 1px rule for an edge, no shadow,
 * no blur. Boxes never nest: inside a panel use `level="sunken"` wells (a
 * shaded field with no edge) or plain ruled rows.
 *
 * `level="ruled"` is the section form the mock prints: no box at all, one rule
 * across the top, so a page reads as one sheet ruled into sections rather than a
 * stack of cards. A box is for a separate task, not for a heading.
 *
 * No motion import here on purpose: candidate-scoped files may render it.
 */
import type { ElementType, HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

export type GlassLevel = 'raised' | 'strong' | 'sunken' | 'ruled';
export type GlassPadding = 'none' | 'sm' | 'md' | 'lg';

const levelClass: Record<GlassLevel, string> = {
  raised: 'glass',
  strong: 'glass-strong',
  sunken: 'glass-sunken',
  ruled: 'sheet-section',
};

const paddingClass: Record<GlassPadding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5 sm:p-6',
  lg: 'p-6 sm:p-8',
};

/** A ruled section starts at the sheet's own edge, so only its top takes space. */
const ruledPaddingClass: Record<GlassPadding, string> = {
  none: '',
  sm: 'pt-4',
  md: 'pt-5',
  lg: 'pt-6',
};

export interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  /**
   * Forwarded to the rendered element. Declared explicitly because
   * `HTMLAttributes` does not carry `ref`; React 19 passes it to function
   * components as an ordinary prop, and it already reaches the host element
   * through the `...rest` spread below — only the type was missing.
   */
  ref?: Ref<HTMLElement>;
  as?: ElementType;
  level?: GlassLevel;
  padding?: GlassPadding;
  children: ReactNode;
}

export function GlassPanel({
  as,
  level = 'raised',
  padding = 'md',
  className,
  children,
  ...rest
}: GlassPanelProps) {
  const Component = (as ?? 'div') as ElementType;
  return (
    <Component
      className={cx(levelClass[level], (level === 'ruled' ? ruledPaddingClass : paddingClass)[padding], className)}
      {...rest}
    >
      {children}
    </Component>
  );
}
