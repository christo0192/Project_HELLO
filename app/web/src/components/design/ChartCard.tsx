import type { ReactNode } from 'react';
import { GlassPanel } from './GlassPanel';
import { SectionHeader } from './SectionHeader';
import { cx } from './cx';

export interface ChartCardProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Reserve body height while a chart loads, so the panel does not jump.
   * Off by default: a bar list or a short summary has no business being
   * padded out to a chart's height (the old 240px default left the
   * dashboard's small panels half empty).
   */
  minHeight?: number;
  /** Small count or badge next to the title. */
  meta?: ReactNode;
  /** Heading level: 2 for a page section, 3 inside a titled section. */
  level?: 2 | 3;
  /** One quiet line under the body (a caveat, a total). */
  footer?: ReactNode;
}

/** One glass panel for a chart or breakdown, with the shared header row. */
export function ChartCard({
  title,
  description,
  actions,
  children,
  className,
  minHeight,
  meta,
  level = 2,
  footer,
}: ChartCardProps) {
  return (
    <GlassPanel as="section" aria-label={title} className={cx('flex flex-col', className)}>
      <SectionHeader
        title={title}
        description={description}
        actions={actions}
        meta={meta}
        level={level}
        className="mb-4"
      />
      <div className="flex-1" style={minHeight ? { minHeight } : undefined}>
        {children}
      </div>
      {footer && <div className="mt-4 text-[12px] leading-4 text-ink-tertiary">{footer}</div>}
    </GlassPanel>
  );
}
