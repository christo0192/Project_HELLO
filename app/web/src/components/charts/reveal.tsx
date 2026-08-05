/**
 * Lightweight chart wrapper.
 *
 * This intentionally avoids rendering third-party motion components in the
 * dashboard route. Production minification/chunking must never turn a chart
 * entrance animation into a page-level React element-type crash.
 */
import type { ReactNode } from 'react';

export interface ChartRevealProps {
  children: ReactNode;
  className?: string;
  /** Kept for API compatibility with chart callers. */
  epoch?: number;
  delaySeconds?: number;
}

export function ChartReveal({ children, className }: ChartRevealProps) {
  return <div className={className}>{children}</div>;
}
