/**
 * Switch: a toggle (`role="switch"`).
 *
 * The knob slides with a CSS transition (no motion import, so the control
 * is safe inside candidate-scoped files) and the track is an ink fill when on.
 * The track has a real border, so its edge survives forced colours. Always
 * paired with a visible label via `aria-labelledby` or `label`.
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
        'relative inline-flex shrink-0 items-center rounded-full border p-px transition-colors duration-hover ease-out',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        'disabled:cursor-not-allowed disabled:opacity-50',
        track,
        checked ? 'border-transparent bg-info' : 'border-[var(--control)] bg-surface',
        !label && className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cx(
          'block rounded-full transition-transform duration-150 ease-out',
          checked ? 'bg-surface' : 'bg-ink-muted',
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
          <span id={descId} className="mt-0.5 block text-label leading-5 text-ink-tertiary">
            {description}
          </span>
        )}
      </div>
      {control}
    </div>
  );
}
