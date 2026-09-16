/**
 * PhoneSlotDialog — pick an IST slot inside a modal instead of inline.
 *
 * WHY. The slot grid is ~26 rows of half-hour windows. Rendered inline it was
 * the tallest thing on the candidate page by a wide margin, pushing the
 * screening cycles, notes and transcript below the fold — and it was on screen
 * permanently, for every candidate, even though booking a slot is rare and
 * deliberate. The information is not wrong, it is simply not wanted until the
 * moment someone decides to book.
 *
 * Moving it behind a button inverts that: the page stays about the candidate,
 * and the grid appears at full size exactly when it is the task at hand.
 *
 * A CONTROLLED DIV, NOT `<dialog>`. Native `<dialog>` + `showModal()` would
 * give focus trapping and Esc for free, but jsdom implements it only partially,
 * so the behaviours worth testing (focus moves in, focus returns, Esc closes)
 * would be untestable exactly where they matter. This does them explicitly.
 *
 * The picker itself is unchanged — including every one of its careful
 * capacity-is-a-projection caveats, which is the point of wrapping rather than
 * reimplementing.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PhoneSlot } from '../../types';
import type { IstDate } from '../../lib/ist-datetime';
import { PhoneSlotPicker } from './PhoneSlotPicker';
import { CandidateButton } from '../design/CandidateControls';
import { cx } from '../design';

export interface PhoneSlotDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  confirmLabel: string;
  /** Advisory copy shown under the title (capacity is a projection). */
  advisory: string;
  date: IstDate;
  onDateChange: (date: IstDate) => void;
  selected: PhoneSlot | null;
  onSelect: (slot: PhoneSlot | null) => void;
  onConfirm: () => void;
  saving?: boolean;
  idPrefix: string;
}

export function PhoneSlotDialog({
  open,
  onClose,
  title,
  confirmLabel,
  advisory,
  date,
  onDateChange,
  selected,
  onSelect,
  onConfirm,
  saving = false,
  idPrefix,
}: PhoneSlotDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Where focus was before the dialog opened, so it can be handed back. Losing
  // focus to <body> on close strands keyboard and screen-reader users at the
  // top of the document.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = `${idPrefix}-dialog-title`;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // Focus the panel itself rather than the first control: the first control
    // is a date input, and dropping a screen reader straight onto it skips the
    // title that explains what is being booked.
    panelRef.current?.focus();
    return () => {
      returnFocusRef.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && !saving) {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose, saving],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={onKeyDown}
    >
      {/* Backdrop. A button so a pointer user can dismiss by clicking away,
          and `aria-hidden` so it is not announced as a second control — Esc
          and Cancel are the accessible paths out. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => { if (!saving) onClose(); }}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'glass relative z-10 w-full max-w-lg rounded-2xl p-5 shadow-xl outline-none',
          'max-h-[85vh] overflow-y-auto',
        )}
      >
        <h2 id={titleId} className="text-[15px] font-semibold text-ink">
          {title}
        </h2>
        <p className="mt-1 text-xs text-ink-tertiary">{advisory}</p>

        <div className="mt-4">
          <PhoneSlotPicker
            date={date}
            onDateChange={onDateChange}
            value={selected?.starts_at ?? null}
            onChange={onSelect}
            idPrefix={idPrefix}
            disabled={saving}
          />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <CandidateButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </CandidateButton>
          <CandidateButton
            variant="primary"
            onClick={onConfirm}
            loading={saving}
            disabled={!selected}
          >
            {confirmLabel}
          </CandidateButton>
        </div>
      </div>
    </div>
  );
}
