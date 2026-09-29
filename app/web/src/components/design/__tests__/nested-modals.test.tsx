/**
 * Nested modals — a `Dialog` opened on top of a `SlideOver`.
 *
 * The real shape: the Scorebar is a `SlideOver` on RolesPage, and Ask Hello's
 * "Replace what you've written?" is a `Dialog` PORTALLED to <body> on top of
 * it. Each open modal registers its own capture-phase listener on `document`,
 * and `stopPropagation` cannot silence a sibling listener on the same node —
 * so before `useModal` kept a stack, one Escape closed BOTH (unmounting the
 * form underneath and losing what was typed) and the two Tab traps fought,
 * pinning focus to the dialog's first control.
 *
 * These pin the stack: only the TOPMOST modal handles Escape and Tab, the one
 * underneath takes over again when the top one closes, the scroll lock holds
 * until the LAST modal closes, and modals may close in any order.
 */

import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Dialog } from '../Dialog';
import { SlideOver } from '../SlideOver';

interface NestedProps {
  /** Render the dialog through a portal, as MetricAskHello does. */
  portal?: boolean;
  dialogBusy?: boolean;
  /** The dialog unmounts SYNCHRONOUSLY inside its own Escape handler. */
  syncClose?: boolean;
  /** Give the dialog a return-focus ref (the normal case). */
  dialogReturnFocus?: boolean;
}

function Nested({
  portal = true,
  dialogBusy = false,
  syncClose = false,
  dialogReturnFocus = true,
}: NestedProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement | null>(null);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  // For `syncClose` only: the drawer's onClose gets a new identity when the
  // dialog OPENS and keeps it through the dialog's close. That puts the
  // drawer's listener AFTER the dialog's and leaves it there, still bound,
  // for the Escape that closes the dialog — the worst listener order. (An
  // inline onClose would be re-bound DURING that close, and a listener
  // re-added mid-dispatch is skipped for the event in flight, hiding the race.)
  const [reboundDrawerClose, setReboundDrawerClose] = useState(() => () => setDrawerOpen(false));

  const dialog = (
    <Dialog
      open={dialogOpen}
      onClose={() => {
        if (syncClose) flushSync(() => setDialogOpen(false));
        else setDialogOpen(false);
      }}
      idPrefix="inner"
      title="Replace what you've written?"
      returnFocusRef={dialogReturnFocus ? dialogTrigger : undefined}
      busy={dialogBusy}
    >
      <button type="button">Keep my text</button>
      <button type="button">Replace with the draft</button>
    </Dialog>
  );

  return (
    <main tabIndex={-1}>
      <button ref={drawerTrigger} type="button" onClick={() => setDrawerOpen(true)}>
        Open drawer
      </button>
      {/* An INLINE onClose, exactly as RolesPage passes it: a fresh function
          every render re-registers the drawer's listener, so after the dialog
          opens the drawer's listener runs AFTER the dialog's. Listener order
          must not decide who handles a key. */}
      <SlideOver
        open={drawerOpen}
        onClose={syncClose ? reboundDrawerClose : () => setDrawerOpen(false)}
        idPrefix="outer"
        title="Scorebar"
        returnFocusRef={drawerTrigger}
      >
        <label>
          Metric name
          <input type="text" />
        </label>
        <button
          ref={dialogTrigger}
          type="button"
          onClick={() => {
            setDialogOpen(true);
            if (syncClose) setReboundDrawerClose(() => () => setDrawerOpen(false));
          }}
        >
          Ask Hello
        </button>
        {portal ? createPortal(dialog, document.body) : dialog}
      </SlideOver>
    </main>
  );
}

const drawer = () => screen.queryByRole('dialog', { name: 'Scorebar' });
const topDialog = () => screen.queryByRole('dialog', { name: "Replace what you've written?" });

/** Drawer open, "Ownership" typed, dialog open on top. */
async function openBoth() {
  await userEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Metric name' }), 'Ownership');
  await userEvent.click(screen.getByRole('button', { name: 'Ask Hello' }));
  expect(topDialog()).not.toBeNull();
  expect(topDialog()).toHaveFocus();
}

afterEach(() => {
  document.body.style.overflow = '';
});

describe('Nested modals — only the TOPMOST one handles keys', () => {
  it.each([
    ['portalled to <body>', true],
    ['rendered inside the drawer', false],
  ])('Escape closes ONLY the dialog (%s); the drawer and what was typed survive', async (_label, portal) => {
    render(<Nested portal={portal} />);
    await openBoth();

    await userEvent.keyboard('{Escape}');

    expect(topDialog()).toBeNull();
    expect(drawer()).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Metric name' })).toHaveValue('Ownership');
    // Focus went back to the control inside the drawer that opened the dialog.
    expect(screen.getByRole('button', { name: 'Ask Hello' })).toHaveFocus();
  });

  it('hands Escape back to the drawer once the dialog has closed', async () => {
    render(<Nested />);
    await openBoth();
    await userEvent.keyboard('{Escape}');
    expect(drawer()).not.toBeNull();

    await userEvent.keyboard('{Escape}');
    expect(drawer()).toBeNull();
    expect(screen.getByRole('button', { name: 'Open drawer' })).toHaveFocus();
  });

  it('Tab cycles WITHIN the dialog and reaches every control — never pinned, never into the drawer', async () => {
    render(<Nested />);
    await openBoth();
    const dialog = topDialog()!;
    const close = screen.getAllByRole('button', { name: 'Close' }).find((b) => dialog.contains(b))!;
    const keep = screen.getByRole('button', { name: 'Keep my text' });
    const replace = screen.getByRole('button', { name: 'Replace with the draft' });

    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(keep).toHaveFocus();
    await userEvent.tab();
    // The control the bug made unreachable by keyboard.
    expect(replace).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(replace).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("gives the drawer its own Tab trap back when the dialog closes", async () => {
    render(<Nested />);
    await openBoth();
    await userEvent.keyboard('{Escape}');
    const ask = screen.getByRole('button', { name: 'Ask Hello' });
    expect(ask).toHaveFocus();

    // Ask Hello is the drawer's LAST control: Tab wraps to its first.
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(drawer()!.contains(document.activeElement)).toBe(true);
  });

  it('a BUSY dialog on top swallows Escape — the drawer underneath does not close either', async () => {
    render(<Nested dialogBusy />);
    await openBoth();

    await userEvent.keyboard('{Escape}');

    expect(topDialog()).not.toBeNull();
    expect(drawer()).not.toBeNull();
  });

  it('one Escape is one action, even when the dialog unmounts synchronously mid-dispatch', async () => {
    render(<Nested syncClose />);
    await openBoth();

    // Dispatched OUTSIDE act(), the way a browser delivers it. Inside act()
    // React defers the effect cleanups to the end of the scope, which hides
    // the race; outside it, `flushSync` commits the close AND runs the
    // dialog's cleanup (leaving the stack) before the drawer's later listener
    // runs. That listener must still not treat the same keypress as its own.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      // Let anything the drawer's listener scheduled land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous;
    }

    expect(topDialog()).toBeNull();
    expect(drawer()).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Metric name' })).toHaveValue('Ownership');
  });

  it('without a return-focus ref, a closing dialog hands focus to the drawer, not to the page behind it', async () => {
    render(<Nested dialogReturnFocus={false} />);
    await openBoth();
    await userEvent.keyboard('{Escape}');
    expect(drawer()).toHaveFocus();
  });
});

/** Two independent modals whose `open` the test drives directly. */
function Pair({ a, b, onCloseA, onCloseB }: {
  a: boolean;
  b: boolean;
  onCloseA: () => void;
  onCloseB: () => void;
}) {
  return (
    <div>
      <SlideOver open={a} onClose={onCloseA} idPrefix="a" title="Lower">
        <button type="button">In lower</button>
      </SlideOver>
      <Dialog open={b} onClose={onCloseB} idPrefix="b" title="Upper">
        <button type="button">In upper</button>
      </Dialog>
    </div>
  );
}

describe('Nested modals — the scroll lock and out-of-order closing', () => {
  it('holds the scroll lock until the LAST modal closes, then restores the page value', async () => {
    document.body.style.overflow = 'scroll';
    render(<Nested />);
    await openBoth();
    expect(document.body.style.overflow).toBe('hidden');

    await userEvent.keyboard('{Escape}');
    // The drawer is still open: the page behind it must not scroll yet.
    expect(document.body.style.overflow).toBe('hidden');

    await userEvent.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('lets the LOWER modal close first: the upper one keeps the keys and the lock', async () => {
    document.body.style.overflow = 'auto';
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const props = { onCloseA, onCloseB };
    const { rerender } = render(<Pair a b={false} {...props} />);
    rerender(<Pair a b {...props} />);

    // The lower one goes first — out of stack order.
    rerender(<Pair a={false} b {...props} />);
    expect(document.body.style.overflow).toBe('hidden');

    await userEvent.keyboard('{Escape}');
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();

    rerender(<Pair a={false} b={false} {...props} />);
    expect(document.body.style.overflow).toBe('auto');
  });

  it('unmounting with BOTH open unlocks the page and leaves no stale entry behind', async () => {
    document.body.style.overflow = 'scroll';
    const first = render(<Nested />);
    await openBoth();
    // A route change: the whole tree goes at once, parent cleanups first.
    first.unmount();
    expect(document.body.style.overflow).toBe('scroll');

    // A fresh modal afterwards is the top one — nothing left in the stack
    // claims the keys.
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} idPrefix="fresh" title="Fresh">
        <button type="button">Inside</button>
      </Dialog>,
    );
    await act(async () => {
      await userEvent.keyboard('{Escape}');
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
