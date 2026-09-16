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

/**
 * Tabbable elements inside the panel, in document order.
 *
 * `:disabled` rather than `:not([disabled])` is load-bearing. The attribute
 * selector only sees a control's OWN attribute, and PhoneSlotPicker disables
 * its slots with `<fieldset disabled>` — those radios are genuinely
 * unfocusable but carry no attribute. While `saving`, the date input, Cancel
 * and Confirm all gain a real `disabled`, so the attribute-only list collapsed
 * to nothing but those radios; Tab then called `preventDefault()` and focused
 * an unfocusable element, i.e. Tab did nothing at all and focus could land on
 * `<body>` — a keyboard trap with no exit, exactly what the trap exists to
 * prevent.
 *
 * Deliberately NOT filtered on `offsetParent !== null`: that is null for every
 * descendant of a `position: fixed` subtree — which is this entire dialog — and
 * it is null for everything under jsdom, where there is no layout at all. It
 * would have emptied this list in both the test environment and the browser.
 */
function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (el) =>
      !el.matches(':disabled') &&
      !el.hasAttribute('hidden') &&
      el.getAttribute('aria-hidden') !== 'true',
  );
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
  const titleId = `${idPrefix}-dialog-title`;
  const descId = `${idPrefix}-dialog-desc`;

  useEffect(() => {
    if (!open) return;
    // Focus the panel itself rather than the first control: the first control
    // is a date input, and dropping a screen reader straight onto it skips the
    // title that explains what is being booked.
    panelRef.current?.focus();
    return () => {
      // After a successful booking the page refetches and the trigger's whole
      // branch can unmount. `focus()` on a detached node is a silent no-op, so
      // merely SKIPPING it is not enough: focus was inside the panel React has
      // just removed, so the browser has already dropped it on <body> and the
      // user's next Tab restarts from the skip link at the top of the document.
      // Fall back to the main landmark, which carries tabIndex={-1} for exactly
      // this purpose, so focus lands near the work instead of above the header.
      const el = returnFocusRef?.current;
      if (el && document.contains(el)) {
        el.focus();
        return;
      }
      const main = document.getElementById('main-content');
      if (main) main.focus();
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

  // Key handling lives on the DOCUMENT in the CAPTURE phase, not on a React
  // `onKeyDown` prop. There is no portal here — see the header comment for why
  // both portal strategies were tried and rejected — so a synthetic handler
  // would in fact fire. Capture is used for a different reason: Escape and Tab
  // must be decided before any ancestor handler sees them, and this dialog is
  // rendered INSIDE the candidate page, whose own key handling would otherwise
  // run first. Capture also guarantees the `saving` refusal cannot be
  // overtaken. Do not "simplify" this to onKeyDown: the ordering is the point.
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      /* Inline, because it must beat whatever the mount point applies. With no
         portal this overlay is a plain child of the page, and its actual parent
         on the candidate page is a `space-y-6` stack — whose sibling selector
         (`> :not([hidden]) ~ :not([hidden])`, specificity 0,2,0) outranks any
         `mt-0` utility. That margin shrinks a `top:0; bottom:0; height:auto`
         box and shifts it down: the backdrop started 24px below the viewport
         top, leaving the app header un-dimmed and still clickable behind an
         `aria-modal` dialog — open the nav drawer from there and Escape then
         closes the wrong thing. A fixed overlay must never inherit flow margins
         from where it happens to be mounted. */
      style={{ marginTop: 0, marginBottom: 0 }}
    >
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
