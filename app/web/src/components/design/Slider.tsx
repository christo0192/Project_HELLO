/**
 * Slider — a styled native `<input type="range">` for the glass design system.
 *
 * Net-new: the shell had no range control. Built on the native element on
 * purpose — it carries `role="slider"` and aria-valuemin/max/now for free from
 * `min`/`max`/`value`, and keeps the platform's keyboard behaviour (arrows,
 * Home/End, PageUp/Down).
 *
 * PAINT: the earlier version used `appearance-none` and then relied only on
 * `accent-color`, which needs the native appearance — so nothing rendered but a
 * bare thumb (a lone dot). This version paints a real filled track and a round
 * knob explicitly:
 *   - Blink/WebKit: a value-driven `linear-gradient` fills the input background
 *     (accent up to the value, soft track after); the runnable-track defines the
 *     8px height so the thumb centres (via a -5px margin), and the thumb is a
 *     round accent knob with a surface-coloured ring + shadow.
 *   - Firefox: `::-moz-range-progress` / `::-moz-range-track` paint the fill and
 *     track natively; `::-moz-range-thumb` matches the WebKit knob.
 * Colour is never the only signal — callers render the value as text beside it.
 *
 * `onValueChange` hands back the numeric value directly so callers do not parse
 * `event.target.value` themselves.
 */
import type { CSSProperties, InputHTMLAttributes } from 'react';
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
  style,
  ...rest
}: SliderProps) {
  const span = max - min;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
  // WebKit/Blink read the filled track from the input's own background.
  const trackStyle: CSSProperties = {
    background: `linear-gradient(to right, var(--info) 0%, var(--info) ${pct}%, var(--info-soft) ${pct}%, var(--info-soft) 100%)`,
    ...style,
  };
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onValueChange(Number(e.target.value))}
      style={trackStyle}
      className={cx(
        'h-2 w-full cursor-pointer appearance-none rounded-full bg-[var(--info-soft)] outline-none',
        // WebKit/Blink track (transparent so the input gradient shows) + centred thumb
        '[&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full',
        '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:h-[18px] [&::-webkit-slider-thumb]:w-[18px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--surface)] [&::-webkit-slider-thumb]:bg-[var(--info)] [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-100',
        'hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-95',
        // Firefox: native fill + track + matching thumb
        '[&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--info-soft)]',
        '[&::-moz-range-progress]:h-2 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[var(--info)]',
        '[&::-moz-range-thumb]:h-[18px] [&::-moz-range-thumb]:w-[18px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-[var(--surface)] [&::-moz-range-thumb]:bg-[var(--info)] [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:transition-transform',
        'hover:[&::-moz-range-thumb]:scale-110 active:[&::-moz-range-thumb]:scale-95',
        // Focus ring (keyboard) + disabled affordance
        'focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
}
