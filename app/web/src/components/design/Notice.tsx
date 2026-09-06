/**
 * Notices and empty/error panels.
 *
 * `InlineNotice` — a one-line status or alert with a tone dot (small text
 * always uses the ink; hue lives in the dot and tint).
 * `EmptyPanel` / `ErrorPanel` — quiet, centred states that sit inside a
 * glass panel without adding another card.
 */
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { usePanelVariants } from '../../lib/motion';
import { Button } from './Button';
import { cx } from './cx';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const toneTint: Record<NoticeTone, string> = {
  info: 'bg-info-soft',
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
  danger: 'bg-error-soft',
  neutral: 'bg-ink/[0.04]',
};

const toneDot: Record<NoticeTone, string> = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-error',
  neutral: 'bg-ink-muted',
};

export interface InlineNoticeProps {
  tone?: NoticeTone;
  children: ReactNode;
  /** `alert` for errors, `status` (default) for confirmations. */
  role?: 'status' | 'alert';
  action?: ReactNode;
  className?: string;
}

export function InlineNotice({ tone = 'info', children, role = 'status', action, className }: InlineNoticeProps) {
  const variants = usePanelVariants();
  return (
    <motion.div
      variants={variants}
      initial="initial"
      animate="enter"
      role={role}
      className={cx(
        'flex flex-wrap items-center gap-3 rounded-[14px] px-3.5 py-2.5 text-sm text-ink',
        toneTint[tone],
        className,
      )}
    >
      <span aria-hidden="true" className={cx('h-2 w-2 shrink-0 rounded-full', toneDot[tone])} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </motion.div>
  );
}

export interface EmptyPanelProps {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  /** Compact vertical padding for use inside tight panels. */
  compact?: boolean;
  className?: string;
}

export function EmptyPanel({ title, hint, action, icon, compact = false, className }: EmptyPanelProps) {
  return (
    <div
      className={cx(
        'glass-sunken flex flex-col items-center justify-center text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      {icon && (
        <span aria-hidden="true" className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-ink-tertiary shadow-pill">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-[13px] leading-5 text-ink-tertiary">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export interface ErrorPanelProps {
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
  className?: string;
}

export function ErrorPanel({ message, onRetry, retryLabel = 'Try again', compact = false, className }: ErrorPanelProps) {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-center justify-center rounded-[14px] bg-error-soft text-center',
        compact ? 'px-4 py-8' : 'px-6 py-12',
        className,
      )}
    >
      <span aria-hidden="true" className="mb-3 h-2 w-2 rounded-full bg-error" />
      <p className="max-w-md text-sm text-ink">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-4">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

/** Centred loading state with an accessible status. */
export function LoadingPanel({ label = 'Loading…', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div role="status" className={cx('flex flex-col items-center justify-center gap-3 text-ink-tertiary', compact ? 'py-8' : 'py-16')}>
      <span aria-hidden="true" className="relative flex h-6 w-6 items-center justify-center">
        <span className="absolute inset-0 rounded-full border-2 border-ink/10" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-info" />
      </span>
      <p className="text-sm">{label}</p>
    </div>
  );
}
