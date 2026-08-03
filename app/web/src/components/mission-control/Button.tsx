import type { CSSProperties } from 'react';
import { cx } from '../design/cx';

/** Inline spinner — same visual contract as the legacy ui Spinner. */
export function MissionSpinner({ className }: { className?: string }) {
  const size: CSSProperties = {};
  return (
    <svg
      className={cx('animate-spin text-current', className ?? 'h-4 w-4')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={size}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
