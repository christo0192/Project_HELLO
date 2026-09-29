/**
 * OverflowMenu — a "More" button that opens a short menu of secondary actions.
 *
 * WHY IT EXISTS. A list row that shows every action it has becomes a row of
 * six equal-weight buttons, and six rows of that is the "sea of buttons" a
 * reviewer reads as a generated admin template. A row should show the ONE
 * action its state calls for; everything else (reference reads, previews,
 * the destructive action) waits one click away, here.
 *
 * WHY IT FLOATS, when `Combobox` expands inline. The combobox lives inside
 * dialogs, whose panels scroll and would clip a popover. This menu's home is
 * a row on a scrolling page, where the opposite problem bites: the rows sit
 * inside `GlassPanel`s, and a panel's `backdrop-filter` makes it a stacking
 * context AND a containing block. A menu rendered in place would be painted
 * UNDER the next panel down the page, and a `ScrollArea` would cut it off.
 * So on a page the menu is portalled to the page's `<main>` (the landmark
 * it belongs to; `<body>` when there is none) and positioned `fixed` against
 * its trigger: no panel above it can clip it or paint over it.
 *
 * INSIDE A MODAL it stays in place instead. `aria-modal` hides everything
 * outside the dialog from assistive tech and `useModal` pulls stray focus
 * back into it, so a portalled menu would be unreadable and unreachable.
 * In place it is still `fixed` (no clipping by the dialog's scroll box); if
 * some ancestor makes itself the containing block (a transform mid-animation,
 * a backdrop filter), the measured offset below corrects for it.
 *
 * It opens below its trigger, aligned to the trigger's end, and FLIPS above
 * when there is not room below (a row near the bottom of the viewport). If
 * neither side fits the whole menu, it takes the larger side and scrolls.
 *
 * THE KEYBOARD CONTRACT (WAI-ARIA APG, "menu button"):
 *   - Trigger: `aria-haspopup="menu"`, `aria-expanded`. Enter / Space /
 *     click / ArrowDown open it on the first item; ArrowUp on the last.
 *   - Menu: ArrowDown / ArrowUp move (and wrap), Home / End jump, a letter
 *     jumps to the next item that starts with it, Enter / Space choose.
 *   - Disabled items stay FOCUSABLE (APG) so their reason, a visible second
 *     line tied by `aria-describedby`, reaches keyboard and screen-reader
 *     users; they cannot be chosen.
 *   - Escape closes and returns focus to the trigger. ESCAPE BELONGS TO THE
 *     MENU FIRST: like `Combobox`, a WINDOW capture-phase listener runs
 *     before `useModal`'s document listener, takes the key and stops it, so
 *     a menu inside a dialog closes and the dialog stays.
 *   - Tab closes it and moves on from the TRIGGER (the menu may sit at the
 *     end of `<body>`, where the browser's own Tab would go nowhere useful).
 *   - A click anywhere else closes it without moving focus.
 *
 * Choosing an item closes the menu, returns focus to the trigger, THEN calls
 * `onSelect(trigger)`. The trigger is handed over so an item that opens a
 * dialog can return focus to it; the menu item itself no longer exists.
 */

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from 'react';
import { createPortal } from 'react-dom';
import { buttonClass } from './Button';
import { cx } from './cx';

export interface OverflowMenuItem {
  /** Stable key within this menu. Never rendered. */
  key: string;
  /** The item's name: shown, and its accessible name. */
  label: string;
  /** Runs after the menu has closed and focus is back on `trigger`. */
  onSelect: (trigger: HTMLButtonElement) => void;
  disabled?: boolean;
  /**
   * Why it cannot be chosen right now, in words. Shown under the label and
   * used as the item's description, so it is read, not just hovered.
   */
  disabledReason?: string;
  /** `danger`: a destructive item, in error ink and set apart by a hairline. */
  tone?: 'default' | 'danger';
  /** Choosing it opens a dialog. */
  haspopup?: 'dialog';
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  /**
   * The trigger's accessible name, e.g. "More actions for Data Analyst". It
   * must START with the visible text (WCAG 2.5.3), so a voice user can say
   * what they see; the rest tells one row's menu from the next.
   */
  label: string;
  /** Visible trigger text. */
  triggerText?: string;
  /** Which trigger edge the menu lines up with. Row ends want `end`. */
  align?: 'start' | 'end';
  disabled?: boolean;
  className?: string;
  /** Reaches the trigger button (e.g. as a dialog's focus-return target). */
  ref?: Ref<HTMLButtonElement>;
}

/** Gap between trigger and menu, and the menu's minimum distance from the viewport edge. */
const GAP = 6;
const EDGE = 8;
/** A menu is never squeezed shorter than this; past it, it scrolls. */
const MIN_HEIGHT = 120;

/** How long letters typed in quick succession count as one search. */
const TYPEAHEAD_MS = 500;

/**
 * Tabbable elements under `root`, in document order. The same rule as
 * `useModal`'s trap: real `:disabled`, never an `offsetParent` test (null for
 * everything under jsdom and under any `position: fixed` subtree).
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

export function OverflowMenu({
  items,
  label,
  triggerText = 'More',
  align = 'end',
  disabled = false,
  className,
  ref,
}: OverflowMenuProps) {
  const uid = useId().replace(/:/g, '');
  const triggerId = `overflow-${uid}-trigger`;
  const menuId = `overflow-${uid}-menu`;
  const itemLabelId = (i: number) => `overflow-${uid}-item-${i}`;
  const itemReasonId = (i: number) => `overflow-${uid}-reason-${i}`;

  /**
   * `null` = closed. Otherwise where focus lands on open, and where the menu
   * renders (`host`; `null` = in place) — decided once, at open, from where
   * the trigger sits.
   */
  const [openState, setOpenState] = useState<{
    focus: 'first' | 'last';
    host: HTMLElement | null;
  } | null>(null);
  const open = openState !== null;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const typeahead = useRef({ text: '', at: 0 });

  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLButtonElement | null }).current = node;
    },
    [ref],
  );

  const close = useCallback((refocus: boolean) => {
    setOpenState(null);
    typeahead.current = { text: '', at: 0 };
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(
    (focus: 'first' | 'last') => {
      if (disabled || items.length === 0) return;
      const trigger = triggerRef.current;
      if (!trigger) return;
      // In a modal: in place. On a page: the page's landmark, so the menu is
      // still "in" the main content for landmark navigation (axe `region`).
      const host = trigger.closest('[aria-modal="true"]')
        ? null
        : (trigger.closest<HTMLElement>('main') ?? document.body);
      setOpenState({ focus, host });
    },
    [disabled, items.length],
  );

  /**
   * Put the menu next to its trigger. Written straight to the node's style —
   * it runs on every scroll frame, and a re-render per frame buys nothing.
   *
   * The containing-block offset: `fixed` coordinates are relative to the
   * viewport UNLESS an ancestor is a containing block, in which case they are
   * relative to that ancestor. Comparing where the menu IS with what its
   * style SAYS measures that offset whichever case applies, so the same
   * arithmetic is right in both.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const t = trigger.getBoundingClientRect();
    const now = menu.getBoundingClientRect();
    const offsetX = now.left - (parseFloat(menu.style.left) || 0);
    const offsetY = now.top - (parseFloat(menu.style.top) || 0);
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;

    // The menu's full height, whatever `max-height` a previous pass set.
    const natural = menu.scrollHeight;
    const width = now.width;
    const below = vh - t.bottom - GAP - EDGE;
    const above = t.top - GAP - EDGE;
    const up = natural > below && above > below;
    const room = Math.max(MIN_HEIGHT, up ? above : below);
    const height = Math.min(natural, room);

    const top = up ? t.top - GAP - height : t.bottom + GAP;
    const wanted = align === 'end' ? t.right - width : t.left;
    const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, vw - EDGE - width));

    menu.style.maxHeight = `${room}px`;
    menu.style.top = `${top - offsetY}px`;
    menu.style.left = `${left - offsetX}px`;
    menu.dataset.side = up ? 'top' : 'bottom';
  }, [align]);

  // Placed and focused BEFORE the first paint, so the menu never flashes at
  // the corner of the screen and a keyboard user never lands nowhere.
  useLayoutEffect(() => {
    if (!openState) return;
    place();
    const nodes = itemRefs.current.slice(0, items.length);
    const target = openState.focus === 'last' ? nodes[nodes.length - 1] : nodes[0];
    target?.focus({ preventScroll: true });
    // Only on opening: re-running as `items` change would yank focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openState]);

  // Follow the trigger while anything scrolls (capture: a scrolling list
  // inside the page, not only the window) or the window resizes.
  useEffect(() => {
    if (!open) return;
    const onMove = (): void => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, place]);

  // Escape closes THIS menu and not the dialog around it — see header.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return;
      const active = document.activeElement;
      const mine =
        (menuRef.current?.contains(active) ?? false) || active === triggerRef.current;
      if (!mine) return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  // A press anywhere else closes it. Floating, the menu takes no space in
  // the layout, so closing on the PRESS moves nothing under the pointer (the
  // reason `Combobox` has to wait for the click does not apply here).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);

  // The menu cannot outlive its trigger being switched off under it.
  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled, open, close]);

  function focusItem(index: number): void {
    const count = items.length;
    if (count === 0) return;
    const i = ((index % count) + count) % count;
    itemRefs.current[i]?.focus({ preventScroll: true });
  }

  function currentIndex(): number {
    return itemRefs.current.findIndex((el) => el !== null && el === document.activeElement);
  }

  function choose(index: number): void {
    const item = items[index];
    const trigger = triggerRef.current;
    if (!item || item.disabled || !trigger) return;
    close(true);
    item.onSelect(trigger);
  }

  /** Tab / Shift+Tab: close, and continue the tab order from the trigger. */
  function tabOut(backwards: boolean): void {
    const trigger = triggerRef.current;
    close(false);
    if (!trigger) return;
    // Inside a modal the order wraps, as `useModal`'s trap would make it.
    const modal = trigger.closest<HTMLElement>('[aria-modal="true"]');
    const list = tabbable(modal ?? document.body);
    const at = list.indexOf(trigger);
    if (at === -1) {
      trigger.focus();
      return;
    }
    const next = at + (backwards ? -1 : 1);
    const target = modal ? list[(next + list.length) % list.length] : list[next];
    (target ?? trigger).focus();
  }

  function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.nativeEvent.isComposing) return;
    const at = currentIndex();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(at + 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(at === -1 ? items.length - 1 : at - 1);
        return;
      case 'Home':
        e.preventDefault();
        focusItem(0);
        return;
      case 'End':
        e.preventDefault();
        focusItem(items.length - 1);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (at >= 0) choose(at);
        return;
      case 'Tab':
        e.preventDefault();
        tabOut(e.shiftKey);
        return;
      default:
        break;
    }
    // Typeahead: a printable character jumps to the next item whose label
    // starts with what has been typed in the last half second.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const stamp = e.timeStamp || Date.now();
      const fresh = stamp - typeahead.current.at > TYPEAHEAD_MS;
      const text = (fresh ? '' : typeahead.current.text) + e.key.toLowerCase();
      typeahead.current = { text, at: stamp };
      // The same letter again ("p", "p") CYCLES through the items starting
      // with it; a longer prefix ("pr", "pre") refines from where focus is.
      const cycling = [...text].every((c) => c === text[0]);
      const search = cycling ? text[0] : text;
      const start = cycling ? at + 1 : Math.max(at, 0);
      for (let step = 0; step < items.length; step += 1) {
        const i = (start + step) % items.length;
        if (items[i].label.toLowerCase().startsWith(search)) {
          focusItem(i);
          break;
        }
      }
    }
  }

  function onTriggerKey(e: ReactKeyboardEvent<HTMLButtonElement>): void {
    // Enter and Space arrive as a click, which opens on the first item.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu('last');
    }
  }

  const menu = openState ? (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-labelledby={triggerId}
      onKeyDown={onMenuKey}
      // Placed by `place()` before the first paint; (0, 0) is the start
      // point its offset measurement needs.
      style={{ position: 'fixed', top: 0, left: 0 }}
      className={cx(
        // The modal material — opaque, hairline, pop shadow — at a menu's
        // radius. Floating over glass, translucency would read as grey.
        'glass-modal z-50 flex w-max min-w-[13rem] max-w-[min(20rem,calc(100vw-1rem))] flex-col',
        'overflow-y-auto overscroll-contain rounded-[14px] p-1.5 outline-none',
        // Same short unfold as the combobox list (index.css), and the same
        // reduced-motion reset.
        'combobox-panel',
      )}
    >
      {items.map((item, i) => {
        const danger = item.tone === 'danger';
        // A hairline sets the destructive item apart from the reads above it.
        const separated = danger && i > 0 && items[i - 1].tone !== 'danger';
        const reason = item.disabled && item.disabledReason ? item.disabledReason : null;
        return (
          <Fragment key={item.key}>
            {separated && <div role="separator" className="-mx-1.5 my-1.5 h-px bg-glass-ring" />}
            <div
              ref={(node) => {
                itemRefs.current[i] = node;
              }}
              role="menuitem"
              tabIndex={-1}
              aria-labelledby={itemLabelId(i)}
              aria-describedby={reason ? itemReasonId(i) : undefined}
              aria-disabled={item.disabled || undefined}
              aria-haspopup={item.haspopup}
              onClick={() => choose(i)}
              // Pointer and keyboard share ONE highlight: hovering an item
              // focuses it, so the arrows continue from where the mouse is.
              onMouseMove={(e) => {
                if (document.activeElement !== e.currentTarget) {
                  e.currentTarget.focus({ preventScroll: true });
                }
              }}
              className={cx(
                'flex min-h-10 flex-col justify-center rounded-[10px] px-2.5 py-2 text-left text-sm outline-none',
                'transition-[background-color,box-shadow] duration-150 ease-soft',
                '[@media(pointer:coarse)]:min-h-11',
                item.disabled
                  ? 'cursor-not-allowed text-ink-tertiary'
                  : cx('cursor-pointer', danger ? 'text-error-text' : 'text-ink'),
                // The highlight is a tint; the keyboard adds the design
                // system's 2px ring, the 3:1 cue a tint alone would not give.
                danger && !item.disabled ? 'focus:bg-error-soft' : 'focus:bg-info/[0.08]',
                'focus-visible:shadow-[inset_0_0_0_2px_var(--info)]',
              )}
            >
              <span id={itemLabelId(i)} className="font-medium">
                {item.label}
              </span>
              {reason && (
                <span id={itemReasonId(i)} className="mt-0.5 text-xs leading-4 text-ink-tertiary">
                  {reason}
                </span>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={setTriggerRef}
        id={triggerId}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(true) : openMenu('first'))}
        onKeyDown={onTriggerKey}
        className={buttonClass(
          'secondary',
          'md',
          cx('gap-1.5 pr-3 aria-expanded:bg-white [@media(pointer:coarse)]:h-11', className),
        )}
      >
        {triggerText}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={cx(
            'h-4 w-4 text-ink-tertiary transition-transform duration-200 ease-soft',
            open && 'rotate-180',
          )}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {menu && (openState?.host ? createPortal(menu, openState.host) : menu)}
    </>
  );
}
