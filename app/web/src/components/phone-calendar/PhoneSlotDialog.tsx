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
 * give focus trapping, Esc and a top-layer for free, but jsdom implements it
 * only partially, so the behaviours worth testing would be untestable exactly
 * where they matter. Choosing the div means OWING those behaviours explicitly:
 *
 *   - a real Tab/Shift+Tab trap. `aria-modal="true"` hides the rest of the
 *     page from assistive tech, so without a trap focus can move to a control
 *     that is both invisible (behind an opaque backdrop) and unannounced. On
 *     this page that includes "Confirm call", which dials a real candidate.
 *   - focus RETURN to the trigger, captured by ref rather than read from
 *     `document.activeElement` — Safari and Firefox do not focus a button on
 *     mouse click, so the heuristic captures `<body>` and returns focus to
 *     nowhere.
 *   - a mount point with NO filtered ancestor. `position: fixed` resolves
 *     against the nearest ancestor carrying a transform/filter/backdrop-filter,
 *     and `.glass` (applied by `SurfaceCard level="base"`) sets
 *     `backdrop-filter` — so a "full-viewport" overlay declared inside such a
 *     card clamps to the card.
 *
 *     The caller therefore renders this OUTSIDE its card rather than inside
 *     it. A portal was tried and rejected: `document.body` is outside React's
 *     root container, so since React 17 no synthetic event reaches it and
 *     Cancel/Book would be dead buttons; portalling into the root container
 *     itself lets React tear the portal's DOM out while reconciling that
 *     container, leaving the panel in the document with a null ref and focus
 *     silently broken. Rendering in a clean position is simpler and correct.
 *   - a body scroll lock, so the page does not slide behind the modal.
 *
 * The picker itself is unchanged — including every one of its careful
 * capacity-is-a-projection caveats, which is the point of wrapping rather than
 * reimplementing.
 */

import { useEffect, useRef } from 'react';
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
  /**
   * The control that opened the dialog. Focus returns here on close.
   * Captured by the CALLER because only the caller still owns the element —
   * reading `document.activeElement` at open time is unreliable (no focus on
   * mouse click in Safari/Firefox) and the trigger may have unmounted by the
   * time the dialog closes.
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

/** Tabbable elements inside the panel, in document order. */
function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');
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
  returnFocusRef,
}: PhoneSlotDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Rendered in place and always present: it is how the portal target is
  // located, and it costs one empty, hidden node.
  const titleId = `${idPrefix}-dialog-title`;
  const descId = `${idPrefix}-dialog-desc`;

  useEffect(() => {
    if (!open) return;
    // Focus the panel itself rather than the first control: the first control
    // is a date input, and dropping a screen reader straight onto it skips the
    // title that explains what is being booked.
    panelRef.current?.focus();
    return () => {
      // Only return focus to something still in the document. After a
      // successful booking the page refetches and the trigger's whole branch
      // can unmount; calling focus() on a detached node silently leaves focus
      // on <body>, which is the outcome this is here to prevent.
      const el = returnFocusRef?.current;
      if (el && document.contains(el)) el.focus();
    };
  }, [open, returnFocusRef]);

  // Body scroll lock: without it a wheel gesture over the backdrop scrolls the
  // candidate page behind the modal.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  // Key handling lives on the DOCUMENT, not on a React `onKeyDown` prop.
  //
  // React attaches its listeners to the ROOT CONTAINER, and this dialog is
  // portalled to `document.body` — outside that container. A synthetic
  // `onKeyDown` on the wrapper therefore never fires for real keystrokes: Esc
  // would not close, and the Tab trap would not trap. That is invisible in a
  // test that fires synthetic events at the React tree and very visible to an
  // operator, so the listener is native and scoped to the open dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      const panel = panelRef.current;
      if (!panel) return;

      if (e.key === 'Escape') {
        if (saving) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      // THE TRAP. `aria-modal` removes the rest of the page from the
      // accessibility tree but NOT from the tab order, so without this, Tab
      // walks onto controls that are invisible behind the backdrop and
      // unannounced — on this page that includes "Confirm call", which dials a
      // real candidate.
      const items = tabbable(panel);
      const active = document.activeElement as HTMLElement | null;

      // Focus somewhere outside the dialog entirely (browser chrome, a stray
      // programmatic focus): pull it back in rather than letting Tab continue
      // through the page behind the backdrop.
      if (active && !panel.contains(active)) {
        e.preventDefault();
        (items[0] ?? panel).focus();
        return;
      }
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!e.shiftKey && (active === last || active === panel)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, saving, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop. A plain div, not a button: a click-focusable control inside
          `aria-hidden` is an axe "needs review" and a nameless button one edit
          away from a violation. Esc and Cancel are the accessible exits. */}
      <div
        aria-hidden="true"
        onClick={() => { if (!saving) onClose(); }}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className={cx(
          'glass relative z-10 w-full max-w-lg rounded-2xl p-5 shadow-xl outline-none',
          'max-h-[85vh] overflow-y-auto',
        )}
      >
        <h2 id={titleId} className="text-[15px] font-semibold text-ink">
          {title}
        </h2>
        <p id={descId} className="mt-1 text-xs text-ink-tertiary">{advisory}</p>

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
            disabled={!selected || saving}
          >
            {confirmLabel}
          </CandidateButton>
        </div>
      </div>
    </div>
  );
}
