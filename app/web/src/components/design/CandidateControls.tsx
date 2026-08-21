/**
 * Candidate-scoped controls and states.
 *
 * Additive replacements for the shared `components/ui` primitives, which
 * hard-code stock Tailwind palette utilities and are frozen because
 * thirteen out-of-scope pages render them. These consume `--c-*` only, so
 * the candidate experience gets the approved palette without a single
 * byte changing in `ui.tsx`.
 *
 * Behaviour, copy and prop shapes mirror the `ui` originals so wiring is a
 * substitution, not a redesign of what the controls do.
 */

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { cx } from './cx';

const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--c-bg)]';

/* ── Spinner ─────────────────────────────────────────────────────── */

export function CandidateSpinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin text-current', className ?? 'h-5 w-5')}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

/* ── Button ──────────────────────────────────────────────────────── */

export type CandidateButtonVariant = 'primary' | 'secondary' | 'ghost';

const buttonStyles: Record<CandidateButtonVariant, string> = {
  primary:
    'bg-[var(--c-accent)] text-[var(--c-data-label-inside)] hover:brightness-95',
  secondary:
    'border border-[var(--c-control-border)] bg-[var(--c-surface)] text-[var(--c-ink-secondary)] hover:bg-[var(--c-border-light)]',
  ghost:
    'text-[var(--c-ink-secondary)] hover:bg-[var(--c-border-light)] hover:text-[var(--c-ink)]',
};

export interface CandidateButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: CandidateButtonVariant;
  loading?: boolean;
}

export function CandidateButton({
  variant = 'primary',
  loading,
  className,
  children,
  disabled,
  ...rest
}: CandidateButtonProps) {
  return (
    <button
      className={cx(
        // 44px minimum target height (WCAG 2.5.8 / 2.5.5 AAA-friendly).
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
        FOCUS_RING,
        'disabled:cursor-not-allowed disabled:opacity-60',
        buttonStyles[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <CandidateSpinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

/* ── Form fields ─────────────────────────────────────────────────── */

/**
 * No width here. `w-full` in the base would be emitted AFTER any `w-auto` a
 * caller passes — Tailwind orders utilities by its own scale, not by the
 * class string — so the override would be silently inert. Callers state the
 * width they want.
 */
const fieldBase = cx(
  'min-h-11 rounded-lg border border-[var(--c-control-border)] bg-[var(--c-surface)] px-3 py-2 text-sm',
  'text-[var(--c-ink)] placeholder:text-[var(--c-ink-muted)]',
  'focus:border-[var(--c-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]',
  'disabled:bg-[var(--c-border-light)]',
);

export function CandidateLabel({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-sm font-medium text-[var(--c-ink-secondary)]"
    >
      {children}
    </label>
  );
}

export function CandidateInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(fieldBase, className)} {...rest} />;
}

export function CandidateSelect({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(fieldBase, 'pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

/* ── States ──────────────────────────────────────────────────────── */

export function CandidateLoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-[var(--c-ink-secondary)]">
      <CandidateSpinner className="h-7 w-7 text-[var(--c-accent)]" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function CandidateErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-[var(--c-negative)] bg-[var(--c-negative-light)] py-12 text-center">
      <p className="max-w-prose px-4 text-sm text-[var(--c-negative)]">{message}</p>
      {onRetry && (
        <CandidateButton variant="secondary" onClick={onRetry}>
          Try again
        </CandidateButton>
      )}
    </div>
  );
}

export function CandidateEmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--c-control-border)] bg-[var(--c-surface)] py-16 text-center">
      <p className="text-sm font-medium text-[var(--c-ink-secondary)]">{title}</p>
      {hint && (
        <p className="max-w-prose px-4 text-sm text-[var(--c-ink-muted)]">{hint}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
