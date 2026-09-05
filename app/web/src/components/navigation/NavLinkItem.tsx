/**
 * NavLinkItem — accessible sidebar navigation link.
 *
 * - Uses react-router `NavLink`; the active state is reflected visually
 *   (a white pill that glides between items via a shared `layoutId`) and
 *   semantically (`aria-current="page"`).
 * - Renders an inline leading icon and a label; the whole row is a single
 *   link, so icon buttons never need their own accessible name.
 */

import { motion } from 'motion/react';
import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSelectionTransition } from '../../lib/motion';
import { cx } from '../design/cx';

export interface NavLinkItemProps {
  to: string;
  label: string;
  icon: ReactNode;
  /** True when this item must be reachable but currently out of scope. */
  end?: boolean;
  onNavigate?: () => void;
}

export function NavLinkItem({
  to,
  label,
  icon,
  end,
  onNavigate,
}: NavLinkItemProps) {
  const transition = useSelectionTransition();
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          'group relative flex h-9 items-center gap-3 rounded-[11px] px-3 text-sm font-medium transition-colors duration-200 ease-soft',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-transparent',
          isActive ? 'text-ink' : 'text-ink-secondary hover:bg-white/50 hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="sidebar-nav-pill"
              aria-hidden="true"
              transition={transition}
              className="absolute inset-0 rounded-[11px] bg-white shadow-pill"
            />
          )}
          <span
            aria-hidden="true"
            className={cx(
              'relative z-10 flex h-4 w-4 items-center justify-center transition-colors duration-200',
              isActive ? 'text-info' : 'text-ink-tertiary group-hover:text-ink-secondary',
            )}
          >
            {icon}
          </span>
          <span className="relative z-10 truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}
