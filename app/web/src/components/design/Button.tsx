/**
 * Button — the shell's action control.
 *
 * Four variants, three sizes, press feedback via a CSS scale transition
 * (collapses under reduced motion through the global media rule). Pure CSS
 * on purpose: buttons are the hottest primitive in the app and a motion
 * element per button made typed-input tests measurably slower in jsdom.
 * `buttonClass()` is exported so router `<Link>`s can wear the same clothes
 * without becoming buttons.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-[color,background-color,box-shadow,transform] duration-200 ease-soft active:scale-[0.97] ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-info text-white shadow-pill hover:bg-[#465f96] active:bg-[#3f568a]',
  secondary:
    'bg-white/70 text-ink shadow-[inset_0_0_0_1px_var(--glass-ring-strong)] hover:bg-white hover:shadow-[inset_0_0_0_1px_var(--glass-ring-strong),0_1px_2px_rgba(15,23,42,0.06)]',
  ghost:
    'text-ink-secondary hover:bg-ink/[0.05] hover:text-ink',
  danger:
    'bg-error text-white shadow-pill hover:bg-[#a54e66] active:bg-[#98475e]',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-4 text-sm',
  /* Write controls and touch surfaces: WCAG 2.5.5 target size. The literal
     `min-h-[44px]` class is what the phone-calendar a11y gate looks for. */
  lg: 'h-11 min-h-[44px] px-5 text-sm',
};

export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return cx(base, variants[variant], sizes[size], extra);
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Leading glyph, decorative. */
  icon?: ReactNode;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <ButtonSpinner /> : icon ? <span aria-hidden="true" className="-ml-0.5 flex h-4 w-4 items-center justify-center">{icon}</span> : null}
      {children}
    </button>
  );
}

export function ButtonSpinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin text-current', className ?? 'h-4 w-4')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
