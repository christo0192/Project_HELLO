/**
 * PhoneSlotDialog — the behaviours that make a modal usable rather than a
 * visual trick.
 *
 * Adversarial review found the first version of this suite mounted every test
 * with `open: true` and never transitioned it. Production always mounts the
 * dialog CLOSED and flips it, so changing the effect deps to `[]` passed the
 * whole suite while breaking focus for every real open — and the focus-return
 * cleanup, one of the three reasons a controlled div was chosen over native
 * `<dialog>`, had zero coverage because no test ever closed anything.
 *
 * Every behavioural test below therefore drives a real `false → true` (and
 * where it matters, `→ false`) transition via rerender. The slots mock also
 * carries `enabled: true`, without which the picker short-circuits to "phone
 * screening is turned off" and the grid the dialog exists to show never
 * renders at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PhoneSlotDialog } from './PhoneSlotDialog';
import type { IstDate } from '../../lib/ist-datetime';

const { getPhoneSlots } = vi.hoisted(() => ({ getPhoneSlots: vi.fn() }));

vi.mock('../../api', () => ({
  api: { getPhoneSlots: (...args: any[]) => getPhoneSlots(...args) },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const DATE = '2026-09-17' as IstDate;
const SLOT = {
  starts_at: '2026-09-17T04:00:00.000Z',
  ends_at: '2026-09-17T04:30:00.000Z',
} as any;

function props(overrides: Partial<React.ComponentProps<typeof PhoneSlotDialog>> = {}) {
  return {
    open: false,
    onClose: vi.fn(),
    title: 'Book a slot',
    confirmLabel: 'Book slot',
    advisory: 'Capacity is a projection, not a reservation.',
    date: DATE,
    onDateChange: vi.fn(),
    selected: null,
    onSelect: vi.fn(),
    onConfirm: vi.fn(),
    saving: false,
    idPrefix: 'test',
    ...overrides,
  };
}

/** Mount closed (as production does), then open. Returns a reopen/close helper. */
function mountThenOpen(overrides: Partial<React.ComponentProps<typeof PhoneSlotDialog>> = {}) {
  const p = props(overrides);
  const view = render(<PhoneSlotDialog {...p} />);
  view.rerender(<PhoneSlotDialog {...p} open />);
  return {
    ...p,
    close: () => view.rerender(<PhoneSlotDialog {...p} open={false} />),
    update: (next: Partial<React.ComponentProps<typeof PhoneSlotDialog>>) =>
      view.rerender(<PhoneSlotDialog {...p} open {...next} />),
  };
}

describe('PhoneSlotDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A COMPLETE payload. The picker maps over each slot's `refusals`, so a
    // partial fixture throws during render — and the suite's strict console
    // policy then surfaces that as an opaque failure rather than a bad mock.
    // `enabled: true` matters just as much: without it the picker
    // short-circuits to "phone screening is turned off" and the grid this
    // dialog exists to show never renders, making every assertion vacuous.
    getPhoneSlots.mockResolvedValue({
      ok: true,
      enabled: true,
      date: DATE,
      window: { time_zone: 'Asia/Kolkata', open_ist: '09:00', close_ist: '21:00' },
      slot_seconds: 1800,
      max_concurrent: 5,
      booked_total: 0,
      occupancy_truncated: false,
      slots: [
        {
          starts_at: SLOT.starts_at,
          ends_at: SLOT.ends_at,
          ist_start: '09:00',
          ist_end: '09:30',
          booked: 0,
          remaining: 5,
          bookable: true,
          refusals: [],
        },
      ],
    });
  });

  it('renders nothing at all when closed, and fetches nothing', () => {
    render(<PhoneSlotDialog {...props()} />);
    // Not merely hidden: an off-screen grid still costs a slots fetch and
    // still sits in the accessibility tree.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getPhoneSlots).not.toHaveBeenCalled();
  });

  it('opens on a false → true transition, which is how production uses it', async () => {
    mountThenOpen();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Book a slot');
    // Proves the picker actually mounted and asked for slots.
    await waitFor(() => expect(getPhoneSlots).toHaveBeenCalled());
  });

  it('moves focus into the dialog when it OPENS, not merely when it mounts', async () => {
    mountThenOpen();
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it('returns focus to the trigger the caller nominated', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Book a slot';
    document.body.appendChild(trigger);
    const ref = { current: trigger } as React.RefObject<HTMLElement | null>;

    const h = mountThenOpen({ returnFocusRef: ref });
    await screen.findByRole('dialog');
    h.close();

    // Reading document.activeElement at open time would have captured <body>
    // (no focus-on-click in Safari/Firefox) and returned focus to nowhere.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('does not throw when the trigger unmounted while the dialog was open', async () => {
    // After a successful booking the page refetches and the trigger's whole
    // branch can disappear. focus() on a detached node silently strands focus.
    const detached = document.createElement('button');
    const ref = { current: detached } as React.RefObject<HTMLElement | null>;
    const h = mountThenOpen({ returnFocusRef: ref });
    await screen.findByRole('dialog');
    expect(() => h.close()).not.toThrow();
  });

  it('traps Tab inside the dialog', async () => {
    // aria-modal hides the page from assistive tech but NOT from the tab
    // order. On this page an untrapped Tab reaches "Confirm call", which dials
    // a real candidate — invisible behind the backdrop and unannounced.
    const outside = document.createElement('button');
    outside.textContent = 'Confirm call';
    document.body.appendChild(outside);

    mountThenOpen({ selected: SLOT });
    const dialog = await screen.findByRole('dialog');

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Book slot' });

    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).not.toBe(outside);
    expect(dialog.contains(document.activeElement)).toBe(true);

    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).not.toBe(outside);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Focus dragged outside entirely must be pulled back in, not allowed to
    // continue through the page behind the backdrop.
    outside.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('keeps the capacity advisory as the dialog’s description', async () => {
    mountThenOpen();
    const dialog = await screen.findByRole('dialog');
    const descId = dialog.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)?.textContent).toMatch(/projection, not a reservation/i);
  });

  it('closes on Escape', async () => {
    const h = mountThenOpen();
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses every exit mid-save, deliberately', async () => {
    // Dismissing while the request is in flight strands the operator with no
    // idea whether the slot was booked.
    const h = mountThenOpen({ saving: true });
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('dismisses on a backdrop click', async () => {
    const h = mountThenOpen();
    const dialog = await screen.findByRole('dialog');
    const backdrop = dialog.parentElement!.querySelector('[aria-hidden="true"]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a backdrop click while saving', async () => {
    const h = mountThenOpen({ saving: true });
    const dialog = await screen.findByRole('dialog');
    const backdrop = dialog.parentElement!.querySelector('[aria-hidden="true"]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('locks body scroll while open and restores it on close', async () => {
    const h = mountThenOpen();
    await screen.findByRole('dialog');
    expect(document.body.style.overflow).toBe('hidden');
    h.close();
    await waitFor(() => expect(document.body.style.overflow).not.toBe('hidden'));
  });

  it('confirms only once a slot is chosen, and not twice', async () => {
    const h = mountThenOpen({ selected: null });
    const confirm = await screen.findByRole('button', { name: 'Book slot' });
    expect(confirm).toBeDisabled();

    h.update({ selected: SLOT });
    fireEvent.click(screen.getByRole('button', { name: 'Book slot' }));
    expect(h.onConfirm).toHaveBeenCalledTimes(1);

    // Mid-save the confirm must not re-fire and double-book.
    h.update({ selected: SLOT, saving: true });
    expect(screen.getByRole('button', { name: /Book slot/ })).toBeDisabled();
  });

  it('cancels without confirming', async () => {
    const h = mountThenOpen();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onConfirm).not.toHaveBeenCalled();
  });
});
