import type { ReactNode } from 'react';
import { GlassPanel } from './GlassPanel';
import { SectionHeader } from './SectionHeader';
import { cx } from './cx';

export interface ChartCardProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Prevents layout jump while the body is loading/chartless. */
  minHeight?: number;
  /** Small count or badge next to the title. */
  meta?: ReactNode;
}

/** Glass panel for chart/KPI blocks with a consistent header row. */
export function ChartCard({
  title,
  description,
  actions,
  children,
  className,
  minHeight = 240,
  meta,
}: ChartCardProps) {
  return (
    <GlassPanel as="section" aria-label={title} className={cx('flex flex-col', className)}>
      <SectionHeader title={title} description={description} actions={actions} meta={meta} className="mb-4" />
      <div className="flex-1" style={{ minHeight }}>
        {children}
      </div>
    </GlassPanel>
  );
}
