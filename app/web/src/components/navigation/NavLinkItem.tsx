/**
 * NavLinkItem — accessible sidebar navigation link.
 *
 * - Uses react-router `NavLink`; the active state is reflected visually
 *   (brand pill) and semantically (`aria-current="page"`).
 * - Renders an inline leading icon and a label; the whole row is a single
 *   link, so icon buttons never need their own accessible name.
 */

import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
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
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-brand-50 text-brand-800 dark:bg-brand-950/60 dark:text-brand-200'
            : 'text-ink-secondary hover:bg-surface-tertiary hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={cx(
              'flex h-4 w-4 items-center justify-center transition-colors',
              isActive
                ? 'text-brand-600 dark:text-brand-300'
                : 'text-ink-tertiary group-hover:text-ink-secondary',
            )}
          >
            {icon}
          </span>
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}
