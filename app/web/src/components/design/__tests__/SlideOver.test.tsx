/**
 * SlideOver — the modal contract, not the appearance.
 *
 * Every test here corresponds to a rule the component's header comment claims
 * to hold. The animation itself is CSS and is deliberately untested: jsdom has
 * no layout, so an assertion about it could only ever check that a class name
 * is spelled the same way twice.
 */

import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { SlideOver } from '../SlideOver';

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
      <SlideOver
        open={open}
        onClose={() => setOpen(false)}
        idPrefix="t"
        title="Scorebar"
        description="Shared metrics."
        returnFocusRef={trigger}
        busy={busy}
      >
        <button type="button">First inside</button>
        <button type="button">Last inside</button>
      </SlideOver>
    </div>
  );
}

const dialog = () => screen.getByRole('dialog');
const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
};

describe('SlideOver', () => {
  it('renders NOTHING until open — a closed drawer is not in the tree', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    // The point of returning null rather than hiding with CSS: the children
    // never mount, so a panel that fetches on mount does not fetch until asked.
    expect(screen.queryByRole('button', { name: 'First inside' })).toBeNull();
  });

  it('is a MODAL, named and described by its own heading and blurb', async () => {
    render(<Harness />);
    await open();
    const panel = dialog();
    expect(panel).toHaveAttribute('aria-modal', 'true');
    // The accessible name must be the heading, not a hard-coded aria-label —
    // otherwise the visible title and the announced one drift apart.
    expect(panel).toHaveAccessibleName('Scorebar');
    expect(panel).toHaveAccessibleDescription('Shared metrics.');
  });

  it('takes focus on open and RETURNS it to the trigger on close', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await open();
    // The panel itself, not the first control: a screen reader dropped onto a
    // control would skip the heading that says what just opened.
    expect(dialog()).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Without this the keyboard user is returned to <body> and the next Tab
    // restarts from the top of the page.
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape and on a backdrop click', async () => {
    render(<Harness />);
    await open();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await open();
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    await act(async () => {
      (backdrop as HTMLElement).click();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('REFUSES every exit while busy, so a save in flight cannot be abandoned', async () => {
    render(<Harness busy />);
    await open();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeNull();

    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    await act(async () => backdrop.click());
    expect(screen.queryByRole('dialog')).not.toBeNull();

    // And the visible exit says so rather than silently doing nothing.
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  });

  it('TRAPS Tab, so it cannot walk onto the controls behind the backdrop', async () => {
    render(<Harness />);
    await open();

    const close = screen.getByRole('button', { name: 'Close' });
    const first = screen.getByRole('button', { name: 'First inside' });
    const last = screen.getByRole('button', { name: 'Last inside' });

    // From the panel, Tab enters the drawer rather than leaving it.
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab();
    expect(last).toHaveFocus();

    // The wrap is the whole guarantee: `aria-modal` hides the page from
    // assistive tech but leaves it in the tab order.
    await userEvent.tab();
    expect(close).toHaveFocus();

    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('pulls focus BACK IN when it is somewhere else entirely', async () => {
    render(<Harness />);
    await open();
    // A stray programmatic focus onto a control behind the backdrop.
    const decoy = screen.getByRole('button', { name: 'Decoy behind the backdrop' });
    act(() => decoy.focus());
    expect(decoy).toHaveFocus();

    await userEvent.tab();
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('locks body scroll while open and restores exactly what was there', async () => {
    document.body.style.overflow = 'scroll';
    render(<Harness />);
    await open();
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.keyboard('{Escape}');
    // Restores the PREVIOUS value, not a hard-coded '' — otherwise a page that
    // set its own overflow loses it every time a drawer opens.
    expect(document.body.style.overflow).toBe('scroll');
    document.body.style.overflow = '';
  });

  it('carries no flow margin, whatever stack it is mounted in', async () => {
    // A `space-y-*` parent's sibling selector outranks any `m-0` utility and
    // would shift a fixed overlay down, un-dimming the app header.
    const onClose = vi.fn();
    render(
      <div className="space-y-6">
        <p>sibling</p>
        <SlideOver open onClose={onClose} idPrefix="m" title="T">
          <span>body</span>
        </SlideOver>
      </div>,
    );
    expect(dialog().parentElement).toHaveStyle({ margin: '0px' });
  });
});
