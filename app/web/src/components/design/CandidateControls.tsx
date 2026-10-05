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
  Ref,
  SelectHTMLAttributes,
} from 'react';
import { cx } from './cx';
import { buttonClass, ButtonSpinner } from './Button';
import type { ButtonSize } from './Button';

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

/**
 * The SAME four variants as the shell's `Button`, and the same classes.
 *
 * This used to be its own button: `rounded-lg` where the shell uses the 12px
 * control radius, a `brightness()` hover that dims the white label along with
 * the fill, a bordered white "secondary" that read as a form field. Beside
 * the shell's buttons (and the frozen LiveKit card) the candidate page ended
 * up showing four button styles at once. One vocabulary now: `buttonClass` is
 * the source of truth, and this wrapper only adds what the candidate surfaces
 * need on top — a `loading` state and a 44px default.
 *
 * `danger-quiet` is the destructive action that is not the point of its
 * surface ("Cancel appointment" beside "Move appointment"); the filled
 * `danger` belongs to a confirmation step, which no candidate surface has.
 */
export type CandidateButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger-quiet';

export interface CandidateButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: CandidateButtonVariant;
  /**
   * `lg` (44px, the default) for write controls and anything that sits in a
   * row with a 44px field; `md` (36px) for toolbar and header actions.
   */
  size?: ButtonSize;
  loading?: boolean;
  /** React 19 ref-as-prop, so hosts can return focus to the trigger. */
  ref?: Ref<HTMLButtonElement>;
}

export function CandidateButton({
  variant = 'primary',
  size = 'lg',
  loading,
  className,
  children,
  disabled,
  ref,
  type = 'button',
  ...rest
}: CandidateButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {/* Decorative: `aria-busy` carries the state, and a `role="status"`
          spinner inside a button would add a second, nameless live region. */}
      {loading && <ButtonSpinner />}
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
 *
 * The 12px control radius, the same as the buttons beside these fields: a
 * field and its button in one row used to disagree (8px vs 12px corners).
 */
const fieldBase = cx(
  'min-h-11 rounded-control border border-[var(--c-control-border)] bg-[var(--c-surface)] px-3 py-2 text-sm',
  'text-[var(--c-ink)] placeholder:text-[var(--c-ink-secondary)]',
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
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  /** React 19 ref-as-prop, so hosts can return focus to the field. */
  ref?: Ref<HTMLInputElement>;
}) {
  return <input ref={ref} className={cx(fieldBase, className)} {...rest} />;
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

/**
 * Error state.
 *
 * Tone lives in the BORDER and the FILL; the message is ink. The approved
 * rose reaches only 3.94:1 on its own tint, and this is normal-weight
 * `text-sm` prose, so WCAG 1.4.3 wants 4.5:1 — the secondary ink gives
 * 9.04:1 on the same ground. This is the identical rule `Tag` applies to its
 * tone labels, and the identical re-pairing move the muted ink, the success
 * ink and the control border each took: the palette is fixed, so the PAIRING
 * changes and the value never does.
 *
 * The state is still unmistakably an error — rose border, rose tint, and on
 * the scoped review route the message itself is the generic unavailable text.
 */
export function CandidateErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-[var(--c-negative)] bg-[var(--c-negative-light)] py-12 text-center">
      <p className="max-w-prose px-4 text-sm text-[var(--c-ink-secondary)]">{message}</p>
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
        <p className="max-w-prose px-4 text-sm text-[var(--c-ink-secondary)]">{hint}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
