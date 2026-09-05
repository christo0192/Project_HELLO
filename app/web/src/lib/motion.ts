/**
 * Motion presets for the HELLO workspace.
 *
 * Page / list / number transitions are implemented with Motion for React
 * (MIT). Every animated preset is gated by `useReducedMotion()`; when the OS
 * requests reduced motion, presets collapse to instant, static values.
 *
 * The emphasized ease and clip-reveal timing constants are adapted from the
 * MIT-licensed bklit-ui chart patterns (`animation.ts`, `motion-utils.ts`,
 * Copyright (c) 2026 uixmat) — exact notice in THIRD_PARTY_NOTICES.md.
 * Nothing is copied from transitions.dev (no license — zero reuse).
 *
 * Glass system additions (docs/design/hello-glass-design-system.md): spring
 * presets for selection pills, switches and press feedback; tab-panel
 * variants; an `useInteractive()` hook that yields hover/press props which
 * vanish under reduced motion.
 */

import { animate } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { Transition, Variants } from 'motion/react';

/* ── Timing & easing ─────────────────────────────────────────────── */

export const EASE_STANDARD = [0.4, 0, 0.2, 1] as const;
/** Adapted from bklit-ui `animation.ts` DEFAULT_ANIMATION_EASING (MIT). */
export const EASE_EMPHASIZED = [0.85, 0, 0.15, 1] as const;
/** Soft deceleration used for reveals and hover settles. */
export const EASE_OUT_SOFT = [0.2, 0.8, 0.2, 1] as const;

export const DURATION_FAST = 0.12;
export const DURATION_BASE = 0.2;
export const DURATION_SLOW = 0.32;

/** Selection pills, switches, press feedback. */
export const SPRING_SNAPPY: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 34,
  mass: 0.9,
};

/** Hover lift, panel settle, layout shifts. */
export const SPRING_GENTLE: Transition = {
  type: 'spring',
  stiffness: 260,
  damping: 30,
  mass: 1,
};

export const pageTransition: Transition = {
  type: 'tween',
  duration: DURATION_SLOW,
  ease: EASE_OUT_SOFT,
};

export const exitTransition: Transition = {
  type: 'tween',
  duration: DURATION_FAST,
  ease: EASE_STANDARD,
};

/* ── Variants ────────────────────────────────────────────────────── */

export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0, transition: pageTransition },
  exit: { opacity: 0, y: -4, transition: exitTransition },
};

/** Tab / section panel entrance. */
export const panelVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  enter: {
    opacity: 1,
    y: 0,
    transition: { type: 'tween', duration: 0.22, ease: EASE_OUT_SOFT },
  },
  exit: { opacity: 0, y: -4, transition: exitTransition },
};

export const staggerContainer: Variants = {
  initial: {},
  enter: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
  exit: {},
};

export const listItemVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  enter: {
    opacity: 1,
    y: 0,
    transition: { type: 'tween', duration: DURATION_BASE, ease: EASE_OUT_SOFT },
  },
  exit: {
    opacity: 0,
    transition: { type: 'tween', duration: DURATION_FAST, ease: EASE_STANDARD },
  },
};

/** Number count-up tween (used by KPI cards). */
export function numberTransition(duration = DURATION_SLOW): Transition {
  return { type: 'tween', duration, ease: EASE_EMPHASIZED };
}

/* ── Reduced motion ──────────────────────────────────────────────── */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Live `prefers-reduced-motion` hook. SSR/jsdom-safe (returns false when
 * matchMedia is unavailable) and reacts to OS changes at runtime.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

const STATIC_VARIANTS: Variants = {
  initial: { opacity: 1, y: 0 },
  enter: { opacity: 1, y: 0 },
  exit: { opacity: 0 },
};

/** Page variants that collapse to static values under reduced motion. */
export function usePageVariants(): Variants {
  const reduced = useReducedMotion();
  return reduced ? STATIC_VARIANTS : pageVariants;
}

/** Tab-panel variants that collapse to static values under reduced motion. */
export function usePanelVariants(): Variants {
  const reduced = useReducedMotion();
  return reduced ? STATIC_VARIANTS : panelVariants;
}

/** List stagger variants that collapse to static values under reduced motion. */
export function useListVariants(): { container: Variants; item: Variants } {
  const reduced = useReducedMotion();
  if (reduced) {
    return {
      container: { initial: {}, enter: {}, exit: {} },
      item: STATIC_VARIANTS,
    };
  }
  return { container: staggerContainer, item: listItemVariants };
}

/**
 * Hover-lift and press-scale props for interactive glass surfaces. Returns
 * an empty object under reduced motion so the element stays perfectly
 * still; spread onto a `motion.*` element.
 */
export function useInteractive(options: { lift?: number; press?: number } = {}): {
  whileHover?: { y: number };
  whileTap?: { scale: number };
  transition?: Transition;
} {
  const reduced = useReducedMotion();
  const { lift = -2, press = 0.985 } = options;
  if (reduced) return {};
  return {
    whileHover: { y: lift },
    whileTap: { scale: press },
    transition: SPRING_SNAPPY,
  };
}

/**
 * Selection-pill spring that collapses to an instant switch under reduced
 * motion (the pill still moves, it just does not animate).
 */
export function useSelectionTransition(): Transition {
  const reduced = useReducedMotion();
  return reduced ? { duration: 0 } : SPRING_SNAPPY;
}

/**
 * Count-up number transition. Renders the target instantly when reduced
 * motion is enabled; otherwise tweens 0 → target with the emphasized ease.
 */
export function useCountUp(
  target: number,
  options: { duration?: number; disabled?: boolean } = {},
): number {
  const { duration = DURATION_SLOW, disabled = false } = options;
  const [display, setDisplay] = useState<number>(disabled ? target : 0);
  const latest = useRef({ target, duration, disabled });
  latest.current = { target, duration, disabled };

  useEffect(() => {
    if (latest.current.disabled) {
      setDisplay(latest.current.target);
      return;
    }
    const controls = animate(0, latest.current.target, {
      duration: latest.current.duration,
      ease: EASE_EMPHASIZED,
      onUpdate: (value) => setDisplay(value),
    });
    return () => controls.stop();
  }, [target, duration, disabled]);

  return display;
}
