import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** Width in px or any CSS width string. */
  width?: number | string;
  /** Height in px or any CSS height string. */
  height?: number | string;
  /** Corner radius in px. */
  radius?: number;
}

/**
 * Neutral shimmer placeholder. `aria-hidden` — the loading state itself must
 * be announced by the surrounding component (e.g. `role="status"`), never by
 * the shimmer visual.
 */
export function Skeleton({
  width,
  height = 12,
  radius = 6,
  className,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx('skeleton', className)}
      style={{ width, height, borderRadius: radius, ...style }}
      {...rest}
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  gap?: number;
  className?: string;
}

/** A stack of shimmer text lines; the last line is shorter. */
export function SkeletonText({ lines = 3, gap = 8, className }: SkeletonTextProps) {
  return (
    <span aria-hidden="true" className={cx('flex w-full flex-col', className)} style={{ gap }}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={12} width={index === lines - 1 ? '62%' : '100%'} />
      ))}
    </span>
  );
}

export interface ChartSkeletonProps {
  className?: string;
  bars?: number;
}

/**
 * Chart-shaped skeleton. Bar heights are deterministic (hash-like formula,
 * never `Math.random()`) following the bklit-ui loading-sweep principle
 * (MIT, Copyright (c) 2026 uixmat) — see THIRD_PARTY_NOTICES.md. Implemented
 * natively, no source copied.
 */
export function ChartSkeleton({ className, bars = 12 }: ChartSkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cx('flex min-h-44 w-full flex-col justify-between gap-5', className)}
    >
      <div className="flex w-full flex-col gap-2">
        <Skeleton height={14} width="34%" />
        <Skeleton height={10} width="52%" />
      </div>
      <div className="flex h-28 items-end gap-1.5 px-1">
        {Array.from({ length: bars }, (_, index) => (
          <Skeleton
            key={index}
            width="100%"
            radius={4}
            height={18 + ((index * 37) % 56)}
          />
        ))}
      </div>
    </div>
  );
}
