/**
 * SegmentedControl — a row of exclusive options with a sliding pill.
 *
 * Semantics: `role="group"` of toggle buttons carrying `aria-pressed`, so
 * filters read correctly to assistive technology. The pill is a shared
 * `layoutId` element so it glides between options (spring, collapses under
 * reduced motion). Horizontal scroll on narrow viewports.
 */
import { LayoutGroup, motion } from 'motion/react';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { useSelectionTransition } from '../../lib/motion';
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
  const groupId = useId();
  const transition = useSelectionTransition();
  return (
    <LayoutGroup id={groupId}>
      <div
        role="group"
        aria-label={ariaLabel}
        className={cx(
          'glass-sunken inline-flex max-w-full items-center gap-0.5 overflow-x-auto p-1',
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
                'relative shrink-0 whitespace-nowrap rounded-[10px] font-medium transition-colors duration-200 ease-soft',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-1',
                'disabled:cursor-not-allowed disabled:opacity-40',
                size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
                selected ? 'text-ink' : 'text-ink-secondary hover:text-ink',
              )}
            >
              {selected && (
                <motion.span
                  layoutId="segment-pill"
                  aria-hidden="true"
                  transition={transition}
                  className="absolute inset-0 rounded-[10px] bg-white shadow-pill"
                />
              )}
              <span className="relative z-10 inline-flex items-center gap-1.5">
                {option.label}
                {option.count != null && (
                  <span
                    className={cx(
                      'tabular-nums',
                      'text-ink-tertiary',
                    )}
                  >
                    {option.count}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
