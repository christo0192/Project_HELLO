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
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx';

export const controlClass = cx(
  'w-full rounded-control bg-white/80 px-3 text-sm text-ink placeholder:text-ink-tertiary',
  // Control boundary must clear WCAG 1.4.11 (3:1): the muted ink is 4.68:1 on white.
  'shadow-[inset_0_0_0_1px_var(--ink-muted)] transition-[box-shadow,background-color] duration-200 ease-soft',
  'hover:bg-white focus:bg-white focus:outline-none focus:shadow-[inset_0_0_0_1.5px_var(--info)]',
  'disabled:cursor-not-allowed disabled:bg-ink/[0.04] disabled:text-ink-tertiary',
);

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Render the control; receives the ids to wire up. */
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
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
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx(inline ? 'flex items-center gap-3' : 'flex flex-col gap-1.5', className)}>
      <label htmlFor={controlId} className="text-[13px] font-medium text-ink-secondary">
        {label}
      </label>
      {children({ id: controlId, describedBy, invalid: Boolean(error) })}
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
      className={cx(controlClass, size === 'sm' ? 'h-8 text-[13px]' : 'h-9', className)}
      {...rest}
    />
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(controlClass, 'min-h-24 resize-y py-2', className)} {...rest} />;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md';
}

export function SelectField({ className, size = 'md', children, ...rest }: SelectFieldProps) {
  return (
    <select
      className={cx(controlClass, 'control-select', size === 'sm' ? 'h-8 text-[13px]' : 'h-9', className)}
      {...rest}
    >
      {children}
    </select>
  );
}
