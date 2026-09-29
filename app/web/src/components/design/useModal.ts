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
 *     be decided before any ancestor handler sees them.
 *
 * What does NOT live here: the overlay markup. The inline `margin: 0`, the
 * `aria-hidden` backdrop, the `role="dialog"` panel and its Close control are
 * each component's own, because they are layout and every shape lays out
 * differently. The caller attaches the returned ref to its `role="dialog"`
 * panel, which must carry `tabIndex={-1}` to be focusable.
 */

import { useEffect, useRef, type RefObject } from 'react';

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
      const main = document.querySelector<HTMLElement>('main');
      if (main) main.focus();
    };
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      const panel = panelRef.current;
      if (!panel) return;

      if (e.key === 'Escape') {
        if (busy) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

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
  }, [open, busy, onClose]);

  return panelRef;
}
