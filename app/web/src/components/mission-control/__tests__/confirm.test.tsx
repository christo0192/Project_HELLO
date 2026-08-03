/**
 * ConfirmButton — explicit confirmation for writable ops.
 * No optimistic anything: onConfirm runs only after an explicit Confirm
 * click, and the panel closes only after the promise settles.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmButton } from '../ConfirmButton';

function renderConfirm(onConfirm: () => Promise<void> | void, props: Partial<Parameters<typeof ConfirmButton>[0]> = {}) {
  return render(
    <ConfirmButton
      label="Apply change"
      summary="Set maintenance ON with reason “window”?"
      onConfirm={onConfirm}
      {...props}
    />,
  );
}

describe('ConfirmButton', () => {
  it('shows the summary and confirm/cancel only after the trigger is pressed', async () => {
    renderConfirm(vi.fn());
    expect(screen.queryByText(/Set maintenance ON/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    expect(screen.getByText(/Set maintenance ON/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('does not call onConfirm until the explicit Confirm click', () => {
    const onConfirm = vi.fn();
    renderConfirm(onConfirm);
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancelling closes the panel without calling onConfirm', () => {
    const onConfirm = vi.fn();
    renderConfirm(onConfirm);
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText(/Set maintenance ON/)).not.toBeInTheDocument();
  });

  it('disables the trigger when disabled', () => {
    renderConfirm(vi.fn(), { disabled: true });
    expect(screen.getByRole('button', { name: 'Apply change' })).toBeDisabled();
  });

  it('stays busy and blocks interaction while onConfirm is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onConfirm = vi.fn(() => gate);
    renderConfirm(onConfirm);
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    // While pending: applying state, both buttons disabled.
    expect(screen.getByRole('button', { name: /Applying/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    });
  });

  it('swallows rejection from onConfirm (caller owns feedback)', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('boom'));
    renderConfirm(onConfirm);
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    });
  });

  it('exposes an accessible expanded state on the trigger', () => {
    renderConfirm(vi.fn());
    const trigger = screen.getByRole('button', { name: 'Apply change' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Apply change' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('has no axe violations', async () => {
    const { container } = renderConfirm(vi.fn());
    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    await expect(container).toHaveNoViolations();
  });
});
