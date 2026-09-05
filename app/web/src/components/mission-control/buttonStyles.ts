/**
 * Shared button style helpers for the Mission Control area. Thin wrappers
 * over the design-system `buttonClass` so every action in this area wears
 * the same glass controls as the rest of the shell.
 */
import { buttonClass } from '../design/Button';
import type { ButtonVariant } from '../design/Button';

export type MissionButtonVariant = 'primary' | 'secondary' | 'danger';

export function buttonClassNames(
  variant: MissionButtonVariant = 'primary',
  extra?: string,
): string {
  // Write controls default to the 44px target size (phone-calendar a11y gate).
  return buttonClass(variant as ButtonVariant, 'lg', extra);
}

export function smallButtonClassNames(
  variant: MissionButtonVariant = 'secondary',
  extra?: string,
): string {
  return buttonClass(variant as ButtonVariant, 'sm', extra);
}
