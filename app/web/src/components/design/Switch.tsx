/**
 * Switch — a macOS-style toggle (`role="switch"`).
 *
 * The knob slides with a CSS transition (no motion import, so the control
 * is safe inside candidate-scoped files) and the track uses the accent when
 * on. Always paired with a visible label via `aria-labelledby` or `label`.
 */
import { useId } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'children'> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Visible label rendered next to the control. */
  label?: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
  size?: 'sm' | 'md';
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  size = 'md',
  className,
  disabled,
  id,
  ...rest
}: SwitchProps) {
  const rawId = useId();
  const switchId = id ?? `switch-${rawId.replace(/:/g, '-')}`;
  const labelId = `${switchId}-label`;
  const descId = `${switchId}-desc`;
  const track = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11';
  const knob = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const travel = size === 'sm' ? 'translate-x-4' : 'translate-x-5';

  const control = (
    <button
      type="button"
      role="switch"
      id={switchId}
      aria-checked={checked}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={description ? descId : undefined}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-soft',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        track,
        checked
          ? 'bg-info shadow-[inset_0_1px_2px_rgba(15,23,42,0.18)]'
          : 'bg-ink/[0.14] shadow-[inset_0_1px_2px_rgba(15,23,42,0.12)]',
        !label && className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cx(
          'block rounded-full bg-white shadow-[0_1px_2px_rgba(15,23,42,0.2),0_0_0_0.5px_rgba(15,23,42,0.06)] transition-transform duration-200 ease-soft',
          knob,
          checked ? travel : 'translate-x-0',
        )}
      />
    </button>
  );

  if (!label) return control;

  return (
    <div className={cx('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <span id={labelId} className="block text-sm font-medium text-ink">
          {label}
        </span>
        {description && (
          <span id={descId} className="mt-0.5 block text-[13px] leading-5 text-ink-tertiary">
            {description}
          </span>
        )}
      </div>
      {control}
    </div>
  );
}
