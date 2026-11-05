/**
 * NavLinkItem: accessible sidebar navigation link.
 *
 * - Uses react-router `NavLink`. The active item is a paper tab with a 3:1
 *   `--control` edge, laid on the desk, shown statically, and it is reflected
 *   semantically with `aria-current="page"`.
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
          'group flex h-8 items-center gap-2.5 rounded-control border px-2.5 text-sm transition-colors duration-hover ease-out',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-tertiary',
          isActive
            ? 'border-[var(--control)] bg-surface font-medium text-ink'
            : 'border-transparent text-ink-secondary hover:bg-ink/[0.05] hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={cx(
              'flex h-4 w-4 items-center justify-center transition-colors duration-hover',
              isActive ? 'text-ink' : 'text-ink-tertiary group-hover:text-ink-secondary',
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
