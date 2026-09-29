/**
 * useModal — the modal CONTRACT, with none of the appearance.
 *
 * Shared by `SlideOver` (a right-edge drawer) and `Dialog` (a centred
 * panel). It is the behaviour `SlideOver` already had — `PhoneSlotDialog`'s
 * contract lifted into the design system, see `SlideOver`'s header for that
 * history — extracted rather than copied when the second modal SHAPE arrived,
 * because a second hand-rolled copy would pay for every rule below again.
 *
 * What lives here, and why each one exists:
 *
 *   - NO `<dialog>`. It would give focus trapping, Esc and the top layer for
 *     free, but jsdom implements none of it, so the whole contract would be
 *     untestable in this repo's test environment. Hence this hook.
 *   - A REAL Tab/Shift+Tab trap. `aria-modal="true"` hides the rest of the
 *     page from assistive tech but NOT from the tab order, so without a trap
 *     Tab walks onto controls that are invisible behind the backdrop and
 *     unannounced.
 *   - FOCUS RETURN by ref, captured by the caller. Reading
 *     `document.activeElement` at open time is unreliable — Safari and Firefox
 *     do not focus a button on mouse click, so the heuristic captures `<body>`
 *     and returns focus to the top of the document.
 *   - Body scroll lock, so a wheel gesture over the backdrop does not scroll
 *     the page behind the modal.
 *   - Key handling on the DOCUMENT in the CAPTURE phase. Escape and Tab must
 *     be decided before any ancestor handler sees them. It stays on
 *     `document`, not `window`, on purpose: a control inside a modal that owns
 *     Escape for itself (an open listbox) listens on WINDOW capture and stops
 *     propagation, so it runs first and closes only itself.
 *   - A module-level STACK of open modals, because modals NEST: the Scorebar
 *     is a `SlideOver`, and Ask Hello's "Replace what you've written?" is a
 *     `Dialog` opened on top of it. Every open modal has its own document
 *     listener, and `stopPropagation` cannot silence a sibling listener on
 *     the same node — so without the stack one Escape closed BOTH (unmounting
 *     the form underneath and losing what the admin typed), and two Tab traps
 *     fought, pinning focus to the dialog's first control. Now only the
 *     TOPMOST open modal acts on Escape and Tab; the rest return early. No
 *     propagation is stopped globally, so the ordering above still holds.
 *     Removal is by identity, not a pop, so modals may close in any order;
 *     the scroll lock is held while ANY modal is open and the page's own
 *     value comes back only when the last one closes.
 *
 *     Known limit: order is OPEN order. Two nested modals mounted open in the
 *     same commit register child-first (React runs child effects first), so
 *     the parent would sit on top. No caller does that — an inner modal opens
 *     from a control inside the outer one.
 *
 * What does NOT live here: the overlay markup. The inline `margin: 0`, the
 * `aria-hidden` backdrop, the `role="dialog"` panel and its Close control are
 * each component's own, because they are layout and every shape lays out
 * differently. The caller attaches the returned ref to its `role="dialog"`
 * panel, which must carry `tabIndex={-1}` to be focusable.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

/** One open modal. Its identity is the stack key; the ref finds its panel. */
interface ModalEntry {
  panelRef: RefObject<HTMLDivElement | null>;
}

/** Open modals, bottom to top, in the order they opened. */
const openModals: ModalEntry[] = [];

/** `body.style.overflow` as it was before the FIRST modal opened. */
let overflowBeforeLock = '';

/**
 * Key events a modal has already acted on. The topmost modal's `onClose` can
 * unmount it SYNCHRONOUSLY (a `flushSync`), and a lower modal whose listener
 * happens to run later in the same dispatch would then find itself on top and
 * close too. Marking the event makes one keypress one action, whatever the
 * listener order. A WeakSet, so a handled event is never kept alive.
 */
const handledKeyEvents = new WeakSet<Event>();

function openModal(entry: ModalEntry): void {
  if (openModals.length === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  openModals.push(entry);
}

/** By identity, not a pop: an outer modal can unmount before an inner one. */
function closeModal(entry: ModalEntry): void {
  const index = openModals.lastIndexOf(entry);
  if (index === -1) return;
  openModals.splice(index, 1);
  if (openModals.length === 0) {
    document.body.style.overflow = overflowBeforeLock;
    overflowBeforeLock = '';
  }
}

function isTopModal(entry: ModalEntry): boolean {
  return openModals[openModals.length - 1] === entry;
}

/** The panel of the highest open modal OTHER than `entry`, if any. */
function panelBelow(entry: ModalEntry): HTMLDivElement | null {
  for (let i = openModals.length - 1; i >= 0; i -= 1) {
    const other = openModals[i]!;
    if (other !== entry && other.panelRef.current) return other.panelRef.current;
  }
  return null;
}

/**
 * Tabbable elements inside the panel, in document order.
 *
 * `:disabled` rather than `:not([disabled])` because the attribute selector
 * only sees a control's OWN attribute, and a control disabled by an ancestor
 * `<fieldset disabled>` carries none.
 *
 * Deliberately NOT filtered on `offsetParent !== null`: that is null for every
 * descendant of a `position: fixed` subtree — which is every modal panel — and
 * null for everything under jsdom, where there is no layout at all. It would
 * empty this list in both the test environment and the browser.
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

export interface UseModalOptions {
  open: boolean;
  onClose: () => void;
  /**
   * The control that opened the modal. Focus returns here on close, and it is
   * the CALLER that owns it — see the header comment for why
   * `document.activeElement` is not good enough.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * While true, Escape refuses to close. For a save in flight. Tab is still
   * trapped but never swallowed — see the handler. The component refuses its
   * backdrop and Close control on the same condition.
   */
  busy?: boolean;
}

/** Returns the ref to attach to the `role="dialog"` panel. */
export function useModal({
  open,
  onClose,
  returnFocusRef,
  busy = false,
}: UseModalOptions): RefObject<HTMLDivElement | null> {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // This modal's stack entry: one object for the component's whole life, so
  // its identity is stable across renders and re-opens.
  const [entry] = useState<ModalEntry>(() => ({ panelRef }));

  useEffect(() => {
    if (!open) return;
    // The panel itself, not the first control: the modal opens onto a heading
    // and a screen reader dropped straight onto a text input would skip it.
    panelRef.current?.focus();
    return () => {
      // `focus()` on a detached node is a silent no-op, so merely skipping it
      // is not enough — focus was inside a subtree React has now removed, and
      // the browser has already moved it to `<body>`. Put it somewhere useful.
      // The ref is read HERE, at close, on purpose — lint suggests copying it
      // at open, but a trigger REMOUNTED in the meantime (say, by a list
      // reload after a save) would leave that copy pointing at a detached
      // node, and focus would fall through to `main` for no reason.
      const el = returnFocusRef?.current;
      if (el && document.contains(el)) {
        el.focus();
        return;
      }
      // A modal still open underneath is where the user IS — `main` sits
      // behind its backdrop, and the next Tab would only be pulled back.
      const below = panelBelow(entry);
      if (below) {
        below.focus();
        return;
      }
      const main = document.querySelector<HTMLElement>('main');
      if (main) main.focus();
    };
  }, [open, returnFocusRef, entry]);

  // Join the stack on open, leave it on close or unmount. The scroll lock
  // rides on the stack (see `openModal`), so nesting cannot unlock the page
  // early or leave it locked after the last modal has gone.
  useEffect(() => {
    if (!open) return;
    openModal(entry);
    return () => closeModal(entry);
  }, [open, entry]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      // ONLY THE TOPMOST MODAL ACTS. Every open modal has a listener on the
      // same node, so this early return is what keeps one Escape from closing
      // the drawer underneath a dialog, and two Tab traps from fighting.
      if (handledKeyEvents.has(e) || !isTopModal(entry)) return;
      const panel = panelRef.current;
      if (!panel) return;

      if (e.key === 'Escape') {
        // Claimed even when refused: a busy dialog on top must not let the
        // Escape through to the modal underneath it.
        handledKeyEvents.add(e);
        if (busy) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      handledKeyEvents.add(e);

      const items = tabbable(panel);
      const active = document.activeElement as HTMLElement | null;

      // Focus outside the modal entirely (browser chrome, a stray
      // programmatic focus): pull it back rather than letting Tab continue
      // through the page behind the backdrop.
      if (active && !panel.contains(active)) {
        e.preventDefault();
        (items[0] ?? panel).focus();
        return;
      }
      if (items.length === 0) {
        // Let Tab GO. Reachable when everything inside carries a real
        // `disabled`. Escape and the backdrop are already refused while busy,
        // so swallowing Tab too would seal a keyboard user in for the duration
        // of a request with no client-side timeout — WCAG 2.1.2. Nothing to
        // trap means nothing to protect.
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
  }, [open, busy, onClose, entry]);

  return panelRef;
}
