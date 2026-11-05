/**
 * The well's buttons unmount the moment it closes, so without a hand-back a
 * keyboard user lands on <body> at the top of the page.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from '../ConfirmButton';

describe('ConfirmButton focus', () => {
  it('returns focus to the trigger after Cancel', async () => {
    const user = userEvent.setup();
    render(<ConfirmButton label="Apply" summary="Apply it?" onConfirm={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus();
  });

  it('returns focus to the trigger after a confirmed write', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmButton label="Apply" summary="Apply it?" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and does not write', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Apply" summary="Apply it?" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    screen.getByRole('button', { name: 'Confirm' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('leaves focus alone when the caller has already moved it to the outcome', async () => {
    const user = userEvent.setup();
    function Host() {
      const outcome = useRef<HTMLParagraphElement | null>(null);
      return (
        <>
          <p ref={outcome} tabIndex={-1}>
            Outcome
          </p>
          <ConfirmButton label="Apply" summary="Apply it?" onConfirm={() => outcome.current?.focus()} />
        </>
      );
    }
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByText('Outcome')).toHaveFocus());
  });
});
