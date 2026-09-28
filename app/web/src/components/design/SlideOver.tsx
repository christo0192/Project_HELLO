/**
 * SlideOver — a right-edge modal drawer.
 *
 * The behaviour here is NOT new. It is `PhoneSlotDialog`'s modal contract
 * lifted into the design system, because that component paid for every rule
 * below in production bugs and a second hand-rolled modal would pay for them
 * again. `PhoneSlotDialog` is deliberately NOT refactored onto this: it is a
 * candidate-facing dialog with its own suite, and rewriting it to prove a
 * shared abstraction is risk with no user on the other end.
 *
 * What is carried over, and why each one exists:
 *
 *   - NO `<dialog>`. It would give focus trapping, Esc and the top layer for
 *     free, but jsdom implements none of it, so the whole contract would be
 *     untestable in this repo's test environment.
 *   - A REAL Tab/Shift+Tab trap. `aria-modal="true"` hides the rest of the
 *     page from assistive tech but NOT from the tab order, so without a trap
 *     Tab walks onto controls that are invisible behind the backdrop and
 *     unannounced.
 *   - FOCUS RETURN by ref, captured by the caller. Reading
 *     `document.activeElement` at open time is unreliable — Safari and Firefox
 *     do not focus a button on mouse click, so the heuristic captures `<body>`
 *     and returns focus to the top of the document.
 *   - `style={{ margin: 0 }}` INLINE. With no portal the overlay is a plain
 *     child of whatever stack renders it, and a `space-y-*` parent's sibling
 *     selector (specificity 0,3,0) outranks any `m-0` utility. That margin
 *     shrinks a `top:0; bottom:0` box and shifts it down, leaving the app
 *     header un-dimmed and still clickable behind an `aria-modal` dialog.
 *   - Body scroll lock, so a wheel gesture over the backdrop does not scroll
 *     the page behind the drawer.
 *   - Key handling on the DOCUMENT in the CAPTURE phase. Escape and Tab must
 *     be decided before any ancestor handler sees them.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from './cx';

/**
 * Tabbable elements inside the panel, in document order.
 *
 * `:disabled` rather than `:not([disabled])` because the attribute selector
 * only sees a control's OWN attribute, and a control disabled by an ancestor
 * `<fieldset disabled>` carries none.
 *
 * Deliberately NOT filtered on `offsetParent !== null`: that is null for every
 * descendant of a `position: fixed` subtree — which is this entire drawer —
 * and null for everything under jsdom, where there is no layout at all. It
 * would empty this list in both the test environment and the browser.
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

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog, rendered as its heading. */
  title: string;
  /** Optional line under the title; also the dialog's accessible description. */
  description?: string;
  /** Namespace for the generated `id`s. Must be unique on the page. */
  idPrefix: string;
  /**
   * The control that opened the drawer. Focus returns here on close, and it is
   * the CALLER that owns it — see the header comment for why
   * `document.activeElement` is not good enough.
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * While true, Escape and the backdrop refuse to close. For a save in flight.
   * Tab is still trapped but never swallowed — see the handler.
   */
  busy?: boolean;
  children: ReactNode;
}

export function SlideOver({
  open,
  onClose,
  title,
  description,
  idPrefix,
  returnFocusRef,
  busy = false,
  children,
}: SlideOverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = `${idPrefix}-slideover-title`;
  const descId = `${idPrefix}-slideover-desc`;

  useEffect(() => {
    if (!open) return;
    // The panel itself, not the first control: the drawer opens onto a heading
    // and a screen reader dropped straight onto a text input would skip it.
    panelRef.current?.focus();
    return () => {
      // `focus()` on a detached node is a silent no-op, so merely skipping it
      // is not enough — focus was inside a subtree React has now removed, and
      // the browser has already moved it to `<body>`. Put it somewhere useful.
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

      // Focus outside the drawer entirely (browser chrome, a stray
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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ margin: 0 }}>
      {/* Backdrop. A plain div, not a button: a click-focusable control inside
          `aria-hidden` is an axe "needs review" and a nameless button one edit
          away from a violation. Esc and Close are the accessible exits. */}
      <div
        aria-hidden="true"
        onClick={() => {
          if (!busy) onClose();
        }}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          'slide-over-panel glass relative z-10 flex h-full w-full max-w-2xl flex-col',
          'overflow-y-auto p-5 shadow-xl outline-none',
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-heading text-ink">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[13px] text-ink-secondary">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            // `disabled` is correct here and `aria-disabled` is not: this is
            // the drawer's only visible exit, and a busy drawer that still
            // LOOKS closable is worse than one that plainly is not. Escape and
            // the backdrop are refused on the same condition.
            disabled={busy}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-[13px] font-medium text-ink-secondary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-info disabled:cursor-not-allowed disabled:opacity-50"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
