/**
 * Slider — a styled native `<input type="range">` for the glass design system.
 *
 * Net-new: the shell had no range control. Built on the native element on
 * purpose — it carries `role="slider"` and aria-valuemin/max/now for free from
 * `min`/`max`/`value`, and keeps the platform's keyboard behaviour (arrows,
 * Home/End, PageUp/Down). Only the paint is ours: an accent-coloured track/thumb
 * via `accent-color`, a focus-visible ring matching every other control, and a
 * disabled affordance. Colour is never the only signal — callers render the
 * value as text beside it.
 *
 * `onValueChange` hands back the numeric value directly so callers do not parse
 * `event.target.value` themselves.
 */
import type { InputHTMLAttributes } from 'react';
import { cx } from './cx';

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  className,
  disabled,
  ...rest
}: SliderProps) {
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onValueChange(Number(e.target.value))}
      className={cx(
        'h-9 w-full cursor-pointer appearance-none bg-transparent accent-info',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
}
