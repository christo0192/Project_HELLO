/**
 * Button — the shell's action control.
 *
 * Six variants, three sizes, press feedback at 0.97 via a CSS scale transition
 * (removed under reduced motion). Pure CSS
 * on purpose: buttons are the hottest primitive in the app and a motion
 * element per button made typed-input tests measurably slower in jsdom.
 * `buttonClass()` is exported so router `<Link>`s can wear the same clothes
 * without becoming buttons.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-quiet' | 'go';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-[color,background-color,border-color,transform] duration-hover ease-out active:scale-[0.97] motion-reduce:active:scale-100 ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  /* The ink fill: the one primary action on a screen. Paper on ink is 16.80:1,
     and hover steps to graphite, 9.27:1. Every filled variant carries a
     transparent border: forced colours drop the fill and draw the border, so
     the button keeps an edge instead of reading as plain text. */
  primary:
    'border border-transparent bg-info text-surface hover:bg-ink-secondary active:bg-ink-secondary',
  /* A real border, not an inset shadow: forced colours keep borders and drop
     shadows, and `--control` clears the 3:1 a control boundary needs. */
  secondary:
    'border border-[var(--control)] bg-surface text-ink hover:bg-surface-secondary',
  ghost:
    'text-ink-secondary hover:bg-ink/[0.05] hover:text-ink',
  /* Filled crimson: Halt all calling and a confirmation step, nothing else.
     Paper on `--danger` is 7.38:1. */
  danger:
    'border border-transparent bg-error text-surface hover:bg-error/90 active:bg-error/90',
  /* GREEN, for "Resume calling" only. The owner asked on 2026-09-29 for the
     resume button to read as green, so `--go` / `--go-strong` exist for this
     one action. White on `--go` is 5.23:1 and on `--go-strong` 6.14:1, both
     over the 4.5:1 a 14px label needs. Hover and press change the FILL only:
     never a `brightness()` filter, which dims the white label along with the
     fill and so LOWERS contrast. Contrast is pinned in global-palette.test.ts. */
  go:
    'border border-transparent bg-[var(--go)] text-white hover:bg-[var(--go-strong)] active:bg-[var(--go-strong)]',
  /* A destructive action that is not the point of its surface: "Archive"
     beside "Edit". Crimson text and a crimson edge; the filled `danger` is
     kept for the confirmation step itself. */
  'danger-quiet':
    'border border-error bg-surface text-error-text hover:bg-surface-secondary',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-label',
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
  /**
   * Reaches the native `<button>` (e.g. a focus-return target). React 19
   * passes `ref` to a function component as an ordinary prop, so the `...rest`
   * spread below forwards it; this line only lets the type checker see it.
   */
  ref?: Ref<HTMLButtonElement>;
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
