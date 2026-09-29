/**
 * Dialog — the modal contract, not the appearance.
 *
 * `Dialog` and `SlideOver` share `useModal`, so these tests exist to prove the
 * contract holds for THIS shape too — a component can import the hook and
 * still forget to wire the ref, the `tabIndex`, or `busy` on its backdrop and
 * Close control. The entrance animation is CSS and deliberately untested:
 * jsdom has no layout, so an assertion about it could only check that a class
 * name is spelled the same way twice.
 */

import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { Dialog } from '../Dialog';

/** The realistic shape: a trigger that owns the return-focus ref. */
function Harness({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Decoy behind the backdrop</button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        idPrefix="t"
        title="Add job mapping"
        description="Point a job at a role."
        returnFocusRef={trigger}
        busy={busy}
      >
        <button type="button">First inside</button>
        <button type="button">Last inside</button>
      </Dialog>
    </div>
  );
}

const dialog = () => screen.getByRole('dialog');
const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
};
const backdrop = () => {
  const el = document.querySelector('[aria-hidden="true"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
};

describe('Dialog', () => {
  it('renders NOTHING until open — a closed dialog is not in the tree', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'First inside' })).toBeNull();
  });

  it('is a MODAL, named and described by its own heading and blurb', async () => {
    render(<Harness />);
    await open();
    const panel = dialog();
    expect(panel).toHaveAttribute('aria-modal', 'true');
    // The name must come from the visible heading, not a hard-coded
    // aria-label — otherwise what is shown and what is announced drift apart.
    expect(panel).toHaveAccessibleName('Add job mapping');
    expect(panel).toHaveAccessibleDescription('Point a job at a role.');
  });

  it('takes focus on open and RETURNS it to the trigger on close', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await open();
    // The panel itself, so a screen reader hears the heading first.
    expect(dialog()).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Without this the keyboard user lands on <body> and the next Tab
    // restarts from the top of the page.
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape, and returns focus from there too', async () => {
    render(<Harness />);
    await open();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  it('closes on a backdrop click', async () => {
    render(<Harness />);
    await open();
    await act(async () => backdrop().click());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('REFUSES every exit while busy, so a save in flight cannot be abandoned', async () => {
    render(<Harness busy />);
    await open();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeNull();

    await act(async () => backdrop().click());
    expect(screen.queryByRole('dialog')).not.toBeNull();

    // And the visible exit says so rather than silently doing nothing.
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  });

  it('TRAPS Tab and Shift+Tab, wrapping at both ends', async () => {
    render(<Harness />);
    await open();

    const close = screen.getByRole('button', { name: 'Close' });
    const first = screen.getByRole('button', { name: 'First inside' });
    const last = screen.getByRole('button', { name: 'Last inside' });

    // From the panel, Tab enters the dialog rather than leaving it.
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab();
    expect(last).toHaveFocus();

    // Forward wrap: past the last control, back to the first — never onto
    // the decoy behind the backdrop.
    await userEvent.tab();
    expect(close).toHaveFocus();

    // Backward wrap: before the first control, round to the last.
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('locks body scroll while open and restores exactly what was there', async () => {
    document.body.style.overflow = 'scroll';
    render(<Harness />);
    await open();
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    // The PREVIOUS value, not a hard-coded '' — a page that set its own
    // overflow must not lose it every time a dialog opens.
    expect(document.body.style.overflow).toBe('scroll');
    document.body.style.overflow = '';
  });

  it('carries no flow margin, whatever stack it is mounted in', () => {
    // A `space-y-*` parent's sibling selector outranks any `m-0` utility and
    // would shift a fixed overlay down, un-dimming the app header.
    render(
      <div className="space-y-6">
        <p>sibling</p>
        <Dialog open onClose={vi.fn()} idPrefix="m" title="T">
          <span>body</span>
        </Dialog>
      </div>,
    );
    expect(dialog().parentElement).toHaveStyle({ margin: '0px' });
  });
});
