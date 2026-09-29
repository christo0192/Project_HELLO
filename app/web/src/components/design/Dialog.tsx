/**
 * Dialog — a centred modal panel, for a short task that needs the page to
 * wait: a two-field form, a confirmation. Anything long or browsable belongs
 * in a `SlideOver` instead.
 *
 * Same props and the same modal contract as `SlideOver`, because both run on
 * `useModal` — focus on open, focus RETURN by caller-owned ref, the real Tab
 * trap, body scroll lock, capture-phase Escape honouring `busy`. That hook's
 * header says why each of those exists. Only the SHAPE differs, and the shape
 * carries its own rules:
 *
 *   - `style={{ margin: 0 }}` INLINE, for the reason `SlideOver` gives: with
 *     no portal the overlay sits in whatever stack renders it, a `space-y-*`
 *     parent's sibling margin outranks any `m-0` utility, and a shifted fixed
 *     box leaves the app header un-dimmed and clickable behind the modal.
 *   - The 16px gutter lives on the OVERLAY (`p-4`), not the panel, and the
 *     panel is `max-h-full` of what remains: so on a phone the panel never
 *     touches the screen edge, and a tall form scrolls INSIDE the panel
 *     rather than pushing its own Close control off-screen.
 *   - `min-w-0` on the panel. It is a flex item, and a flex item's automatic
 *     minimum width is its content's — one long unbreakable string would
 *     otherwise widen the panel past the viewport and scroll the page
 *     sideways.
 */

import type { ReactNode, RefObject } from 'react';
import { cx } from './cx';
import { useModal } from './useModal';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog, rendered as its heading. */
  title: string;
  /** Optional line under the title; also the dialog's accessible description. */
  description?: string;
  /** Namespace for the generated `id`s. Must be unique on the page. */
  idPrefix: string;
  /**
   * The control that opened the dialog. Focus returns here on close, and it
   * is the CALLER that owns it — see `useModal` for why
   * `document.activeElement` is not good enough.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * While true, Escape, the backdrop and Close all refuse. For a save in
   * flight. Tab is still trapped but never swallowed — see `useModal`.
   */
  busy?: boolean;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  idPrefix,
  returnFocusRef,
  busy = false,
  children,
}: DialogProps) {
  const panelRef = useModal({ open, onClose, returnFocusRef, busy });
  const titleId = `${idPrefix}-dialog-title`;
  const descId = `${idPrefix}-dialog-desc`;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      style={{ margin: 0 }}
    >
      {/* Backdrop. A plain div, not a button — same reasoning as SlideOver:
          a click-focusable control inside `aria-hidden` is an axe "needs
          review". Esc and Close are the accessible exits. */}
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
          'dialog-panel glass relative z-10 flex max-h-full w-full min-w-0 max-w-lg flex-col',
          'overflow-y-auto overscroll-contain p-5 shadow-xl outline-none',
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-heading text-ink">
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
            // `disabled`, not `aria-disabled`: a busy dialog that still LOOKS
            // closable is worse than one that plainly is not. Escape and the
            // backdrop are refused on the same condition.
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
