/**
 * Left-to-right clip reveal for chart entrances.
 *
 * Pattern adapted from bklit-ui `chart-reveal-clip.tsx` (MIT, Copyright (c)
 * 2026 uixmat) — see THIRD_PARTY_NOTICES.md. bklit animates an SVG clipPath
 * rect; we keep the LTR clip concept and implement it as a CSS `clip-path:
 * inset()` animation on a container div. Gated by prefers-reduced-motion.
 */
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { EASE_EMPHASIZED, useReducedMotion } from '../../lib/motion';

export interface ChartRevealProps {
  children: ReactNode;
  className?: string;
  /** Bump to replay the reveal (e.g. when data identity changes). */
  epoch?: number;
  delaySeconds?: number;
}

export function ChartReveal({
  children,
  className,
  epoch = 0,
  delaySeconds = 0,
}: ChartRevealProps) {
  const reduced = useReducedMotion();
  if (reduced) {
    return <div className={className}>{children}</div>;
  }
  return (
    <motion.div
      key={epoch}
      className={className}
      initial={{ clipPath: 'inset(0 100% 0 0 round 8px)' }}
      animate={{ clipPath: 'inset(0 0% 0 0 round 8px)' }}
      transition={{
        type: 'tween',
        duration: 0.55,
        ease: EASE_EMPHASIZED,
        delay: delaySeconds,
      }}
    >
      {children}
    </motion.div>
  );
}
