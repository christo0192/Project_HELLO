/**
 * Explicit-confirmation mutation trigger for writable admin surfaces.
 *
 * Flow: idle trigger button → an inline `glass-sunken` well that rises in
 * and summarises the EXACT change → "Confirm" runs `onConfirm` (busy +
 * disabled while pending) → returns to idle. Nothing is applied
 * optimistically: the caller awaits `onConfirm` (which performs the real
 * API call) and only then renders success/error feedback from the actual
 * response.
 */

import { motion } from 'motion/react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { usePanelVariants } from '../../lib/motion';
import { Button, buttonClass, cx } from '../design';
import type { ButtonVariant } from '../design';
import type { MissionButtonVariant } from './buttonStyles';

/** Mission variants are a subset of the design-system button variants. */
function toButtonVariant(variant: MissionButtonVariant): ButtonVariant {
  return variant;
}

export interface ConfirmButtonProps {
  /** Label of the trigger button (idle state). */
  label: string;
  /** Exact change summary shown in the confirmation panel. */
  summary: ReactNode;
  /** Real mutation; must resolve/reject, caller owns feedback. */
  onConfirm: () => Promise<void> | void;
  variant?: MissionButtonVariant;
  confirmLabel?: string;
  cancelLabel?: string;
  disabled?: boolean;
  className?: string;
  /**
   * A quieter TRIGGER for an action that sits beside the main one (Archive
   * next to Edit): standard height, and `danger` becomes the outlined
   * `danger-quiet`. The confirmation step keeps the full-strength variant —
   * the moment of commitment is where the weight belongs.
   */
  quiet?: boolean;
}

export function ConfirmButton({
  label,
  summary,
  onConfirm,
  variant = 'primary',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  disabled = false,
  className,
  quiet = false,
}: ConfirmButtonProps) {
  const rawId = useId();
  const confirmId = `confirm-${rawId.replace(/:/g, '-')}`;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelVariants = usePanelVariants();

  async function run() {
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      // The caller owns error feedback; never leave an unhandled rejection.
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    // Quiet mode sits in a flex row of sibling actions. `contents` lets the
    // trigger stay IN that row and the confirmation panel (`basis-full
    // order-last`) drop to its own full-width line beneath it, so opening the
    // confirmation never reshuffles the buttons around it.
    <div className={cx(quiet && 'contents', className)}>
      <Button
        size={quiet ? 'md' : 'lg'}
        variant={quiet && variant === 'danger' ? 'danger-quiet' : toButtonVariant(variant)}
        onClick={() => setConfirming((open) => !open)}
        aria-expanded={confirming}
        aria-controls={confirming ? confirmId : undefined}
        disabled={disabled}
      >
        {label}
      </Button>

      {confirming && (
        <motion.div
          id={confirmId}
          variants={panelVariants}
          initial="initial"
          animate="enter"
          className={cx(
            'glass-sunken rounded-[14px] p-4',
            quiet ? 'order-last w-full basis-full' : 'mt-3',
          )}
        >
          <p className="text-sm text-ink">{summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              variant={toButtonVariant(variant)}
              loading={busy}
              onClick={() => void run()}
            >
              {busy ? 'Applying…' : confirmLabel}
            </Button>
            <Button size="lg" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
              {cancelLabel}
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

/** Small inline link-style action (pagination, filters, secondary). */
export function LinkAction({
  children,
  onClick,
  disabled,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={buttonClass('secondary', 'sm', className)}
    >
      {children}
    </button>
  );
}
