/**
 * Shared button style helpers for the Mission Control area (design-token
 * based). Kept in a pure module so component files stay fast-refresh clean.
 */
import { cx } from '../design/cx';

export type MissionButtonVariant = 'primary' | 'secondary' | 'danger';

export function buttonClassNames(
  variant: MissionButtonVariant = 'primary',
  extra?: string,
): string {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
    'disabled:cursor-not-allowed disabled:opacity-60',
    variant === 'primary' &&
      'bg-brand-600 text-white shadow-sm hover:bg-brand-700 focus-visible:ring-brand-500',
    variant === 'secondary' &&
      'border border-line bg-surface text-ink hover:bg-surface-tertiary focus-visible:ring-info',
    variant === 'danger' &&
      'bg-error text-white shadow-sm hover:bg-error/90 focus-visible:ring-error',
    extra,
  );
}

export function smallButtonClassNames(
  variant: MissionButtonVariant = 'secondary',
  extra?: string,
): string {
  return buttonClassNames(variant, cx('px-2.5 py-1.5 text-xs', extra));
}
