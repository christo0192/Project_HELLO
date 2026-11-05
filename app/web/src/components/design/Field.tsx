/**
 * Form field primitives: `Field` (label + hint + error wiring), `TextField`
 * and `SelectField` (styled native controls). Native elements keep the
 * platform's keyboard and assistive-technology behaviour; only the paint
 * changes.
 */
import { useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx';

export const controlClass = cx(
  'w-full rounded-control border border-[var(--control)] bg-surface px-3 text-sm text-ink placeholder:text-ink-tertiary',
  // A real border, so it survives forced colours; `--control` clears WCAG
  // 1.4.11's 3:1 on paper and on a shaded field. Focus thickens it to a 2px ink
  // edge, the same weight as the ring on every other control.
  'transition-[border-color,background-color] duration-hover ease-out',
  'hover:bg-surface-secondary focus:bg-surface focus:outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_1px_var(--ink)]',
  'disabled:cursor-not-allowed disabled:bg-surface-secondary disabled:text-ink-tertiary',
);

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Render the control; receives the ids to wire up. */
  children: (ids: { id: string; labelId: string; describedBy?: string; invalid: boolean }) => ReactNode;
  id?: string;
  className?: string;
  /** Places the label after the control (checkbox-like layouts). */
  inline?: boolean;
}

export function Field({ label, hint, error, children, id, className, inline }: FieldProps) {
  const rawId = useId();
  const controlId = id ?? `field-${rawId.replace(/:/g, '-')}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const labelId = `${controlId}-label`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx(inline ? 'flex items-center gap-3' : 'flex flex-col gap-1.5', className)}>
      {/* A form label: 12px at Plex's condensed width, sentence case. Hints and
          errors are the meta size with a prose line height (12/20): they can
          run to two lines, where 16px leading crowds. */}
      <label id={labelId} htmlFor={controlId} className="form-label">
        {label}
      </label>
      {children({ id: controlId, labelId, describedBy, invalid: Boolean(error) })}
      {hint && !error && (
        <p id={hintId} className="text-xs leading-5 text-ink-tertiary">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs leading-5 text-error-text">
          {error}
        </p>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md';
}

export function TextField({ className, size = 'md', ...rest }: TextFieldProps) {
  return (
    <input
      className={cx(controlClass, size === 'sm' ? 'h-7 text-label' : 'h-9', className)}
      {...rest}
    />
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(controlClass, 'min-h-24 resize-y py-2', className)} {...rest} />;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md';
  /**
   * Reaches the native `<select>`. React 19 passes `ref` to a function
   * component as an ordinary prop, so the `...rest` spread below forwards it
   * with no `forwardRef` — this line only lets the type checker see it. For
   * a caller that must move focus onto the control (say, after a retry).
   */
  ref?: Ref<HTMLSelectElement>;
}

export function SelectField({ className, size = 'md', children, ...rest }: SelectFieldProps) {
  return (
    <select
      className={cx(controlClass, 'control-select', size === 'sm' ? 'h-7 text-label' : 'h-9', className)}
      {...rest}
    >
      {children}
    </select>
  );
}
