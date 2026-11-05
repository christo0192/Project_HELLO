/**
 * SegmentedControl: a row of exclusive options, printed as one control.
 *
 * Semantics: `role="group"` of toggle buttons carrying `aria-pressed`, so
 * filters read correctly to assistive technology. The selected option is an
 * ink fill, shown statically: nothing slides. Horizontal scroll on narrow
 * viewports.
 */
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Small count rendered after the label. */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the group. */
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cx(
        'inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-control border border-[var(--control)] bg-surface p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cx(
              'shrink-0 whitespace-nowrap rounded-evidence font-medium transition-colors duration-hover ease-out',
              // Inset, because the track scrolls and would clip a ring drawn
              // outside it; paper on the ink fill, ink everywhere else.
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset',
              selected ? 'focus-visible:ring-surface' : 'focus-visible:ring-info',
              'disabled:cursor-not-allowed disabled:opacity-40',
              // Type scale: meta (12/16) for the compact control, label
              // (13/20) otherwise; medium weight either way. The md track, with
              // its edge and padding, comes to the 36px control height.
              size === 'sm' ? 'h-6 px-2.5 text-meta' : 'h-[30px] px-3 text-label',
              selected ? 'bg-info text-surface' : 'text-ink-secondary hover:bg-surface-secondary hover:text-ink',
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {option.label}
              {option.count != null && (
                <span className={cx('tabular-nums', selected ? 'text-surface' : 'text-ink-tertiary')}>
                  {option.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
