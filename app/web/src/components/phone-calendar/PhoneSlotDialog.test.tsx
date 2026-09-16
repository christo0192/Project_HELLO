/**
 * PhoneSlotDialog — the behaviours that make a modal usable rather than a
 * visual trick.
 *
 * Moving the slot grid behind a button is only an improvement if the dialog
 * can be opened, escaped and dismissed without a mouse, and if it hands focus
 * back where it came from. Those are the parts a screenshot cannot verify and
 * a refactor silently breaks, so they are what is tested here — not that a div
 * rendered.
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

function setup(overrides: Partial<React.ComponentProps<typeof PhoneSlotDialog>> = {}) {
  const props = {
    open: true,
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
  render(<PhoneSlotDialog {...props} />);
  return props;
}

describe('PhoneSlotDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPhoneSlots.mockResolvedValue({
      date: DATE,
      slots: [],
      max_concurrent: null,
      occupancy_truncated: false,
    });
  });

  it('renders nothing at all when closed', () => {
    setup({ open: false });
    // Not merely hidden: an off-screen grid still costs a slots fetch and
    // still lands in the accessibility tree.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getPhoneSlots).not.toHaveBeenCalled();
  });

  it('is a labelled modal dialog', async () => {
    setup();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The accessible name must be the task, not the component.
    expect(dialog).toHaveAccessibleName('Book a slot');
  });

  it('keeps the capacity advisory visible inside the dialog', async () => {
    // The projection caveat travels WITH the grid. Leaving it on the page
    // behind the backdrop would put the number and its disclaimer in two
    // different places, which is how "2 remaining" gets read as a promise.
    setup();
    expect(
      await screen.findByText(/Capacity is a projection, not a reservation\./i),
    ).toBeInTheDocument();
  });

  it('moves focus into the dialog on open', async () => {
    setup();
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it('closes on Escape', async () => {
    const props = setup();
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses to close on Escape mid-save', async () => {
    // Dismissing while the request is in flight strands the operator with no
    // idea whether the slot was booked.
    const props = setup({ saving: true });
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('confirms only once a slot is chosen', async () => {
    const props = setup({ selected: null });
    const confirm = await screen.findByRole('button', { name: 'Book slot' });
    expect(confirm).toBeDisabled();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('confirms the chosen slot', async () => {
    const slot = {
      starts_at: '2026-09-17T04:00:00.000Z',
      ends_at: '2026-09-17T04:30:00.000Z',
    } as any;
    const props = setup({ selected: slot });
    fireEvent.click(await screen.findByRole('button', { name: 'Book slot' }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels without confirming', async () => {
    const props = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
});
