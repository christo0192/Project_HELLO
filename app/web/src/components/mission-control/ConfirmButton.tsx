/**
 * Explicit-confirmation mutation trigger for writable admin surfaces.
 *
 * Flow: idle trigger button → inline confirmation panel that summarises
 * the EXACT change → "Confirm" runs `onConfirm` (busy + disabled while
 * pending) → returns to idle. Nothing is applied optimistically: the
 * caller awaits `onConfirm` (which performs the real API call) and only
 * then renders success/error feedback from the actual response.
 */

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../design/cx';
import { buttonClassNames } from './buttonStyles';
import { MissionSpinner } from './Button';
import type { MissionButtonVariant } from './buttonStyles';

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
}: ConfirmButtonProps) {
  const rawId = useId();
  const confirmId = `confirm-${rawId.replace(/:/g, '-')}`;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

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
    <div className={className}>
      <button
        type="button"
        onClick={() => setConfirming((open) => !open)}
        aria-expanded={confirming}
        aria-controls={confirming ? confirmId : undefined}
        disabled={disabled}
        className={buttonClassNames(variant)}
      >
        {label}
      </button>

      {confirming && (
        <div
          id={confirmId}
          className="mt-3 rounded-lg border border-line bg-surface-secondary p-4"
        >
          <p className="text-sm text-ink">{summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy}
              className={buttonClassNames(variant)}
            >
              {busy && <MissionSpinner className="h-4 w-4" />}
              {busy ? 'Applying…' : confirmLabel}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className={buttonClassNames('secondary')}
            >
              {cancelLabel}
            </button>
          </div>
        </div>
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
      className={cx(
        'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-secondary transition-colors',
        'hover:bg-surface-tertiary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-info',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}
