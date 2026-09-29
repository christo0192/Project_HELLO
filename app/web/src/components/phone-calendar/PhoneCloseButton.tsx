/**
 * The one "close this panel" control on the phone calendar: a 44px ghost
 * square with a drawn ×, named for what it closes. Shared by the booking
 * panel and the appointment detail so both close the same way, and sized for
 * touch so the a11y gate's 44px rule holds.
 */

import { Button, cx } from '../design';

export function PhoneCloseButton({
  label,
  onClick,
  className,
}: {
  /** The accessible name, e.g. "Close booking form". */
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      size="lg"
      variant="ghost"
      onClick={onClick}
      aria-label={label}
      className={cx('w-11 shrink-0 !px-0', className)}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        className="h-4 w-4"
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </Button>
  );
}
