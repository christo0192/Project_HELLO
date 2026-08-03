/**
 * MobileMenuButton — hamburger / close toggle for the responsive drawer.
 *
 * WAI-ARIA 1.2 disclosure pattern: `aria-expanded` reflects the drawer
 * state and `aria-controls` points at the sidebar element. The button is
 * visible only below the `lg` breakpoint (CSS).
 */

import type { Ref } from 'react';
import { cx } from '../design/cx';
import { CloseIcon, MenuIcon } from './icons';

export interface MobileMenuButtonProps {
  open: boolean;
  onToggle: () => void;
  className?: string;
  /** React 19 ref-as-prop; Layout returns focus here on close. */
  ref?: Ref<HTMLButtonElement>;
}

export function MobileMenuButton({
  open,
  onToggle,
  className,
  ref,
}: MobileMenuButtonProps) {
  return (
    <button
      type="button"
      ref={ref}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="app-sidebar"
      aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
      className={cx(
        'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-secondary transition-colors hover:bg-surface-tertiary hover:text-ink lg:hidden',
        className,
      )}
    >
      {open ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
    </button>
  );
}
