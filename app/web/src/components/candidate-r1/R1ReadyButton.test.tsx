import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { R1ReadyButton } from './R1ReadyButton';
import { R1_READY_COPY } from './r1-copy';

const BUTTON = { name: "I'm ready" };

describe('the ready button', () => {
  it('uses the wording the owner asked for', () => {
    expect(R1_READY_COPY.button).toBe("I'm ready");
    expect(R1_READY_COPY.sent).toBe('Sent — starting the role-play');
    expect(R1_READY_COPY.failed).toBe("We couldn't send that. Just say “I'm ready”.");
  });

  it('is a native button with no alert or confirmation before it is pressed', () => {
    render(<R1ReadyButton onReady={vi.fn()} />);
    const button = screen.getByRole('button', BUTTON);
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).not.toHaveFocus();
    expect(screen.queryByRole('alert')).toBeNull();
    // The polite region exists up front (empty), so a later message is announced.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('sends once and confirms in the polite region', async () => {
    const user = userEvent.setup();
    const onReady = vi.fn().mockResolvedValue(undefined);
    render(<R1ReadyButton onReady={onReady} />);
    await user.click(screen.getByRole('button', BUTTON));
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Sent — starting the role-play')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Sent — starting the role-play');
    expect(screen.getByRole('button', BUTTON)).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', BUTTON));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on the button while sending (aria-disabled, not disabled)', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onReady = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<R1ReadyButton onReady={onReady} />);
    await user.click(screen.getByRole('button', BUTTON));
    const sending = screen.getByRole('button', { name: 'Sending…' });
    expect(sending).toHaveAttribute('aria-disabled', 'true');
    expect(sending).not.toBeDisabled();
    expect(sending).toHaveFocus();
    await act(async () => finish());
  });

  it('ignores a second press while the first is in flight', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onReady = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<R1ReadyButton onReady={onReady} />);
    await user.click(screen.getByRole('button', BUTTON));
    await user.click(screen.getByRole('button', { name: 'Sending…' }));
    await user.keyboard('{Enter}');
    expect(onReady).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('says what to do instead when it could not be sent, and can be pressed again', async () => {
    const user = userEvent.setup();
    const onReady = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('http_500'))
      .mockResolvedValue(undefined);
    render(<R1ReadyButton onReady={onReady} />);
    await user.click(screen.getByRole('button', BUTTON));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't send that. Just say “I'm ready”.");
    // The raw error never reaches the candidate.
    expect(document.body.textContent).not.toContain('http_500');
    const button = screen.getByRole('button', BUTTON);
    expect(button).not.toHaveAttribute('aria-disabled');

    await user.click(button);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Sent — starting the role-play')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not update after it has been removed (the interviewer moved on mid-request)', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onReady = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { unmount } = render(<R1ReadyButton onReady={onReady} />);
    await user.click(screen.getByRole('button', BUTTON));
    unmount();
    // Would warn ("state update on an unmounted component") and fail the run if it set state.
    await act(async () => finish());
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations idle, sending, sent or failed', async () => {
    const user = userEvent.setup();
    const onReady = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue(undefined);
    const { container } = render(<R1ReadyButton onReady={onReady} />);
    await expect(container).toHaveNoViolations();
    await user.click(screen.getByRole('button', BUTTON));
    await screen.findByRole('alert');
    await expect(container).toHaveNoViolations();
    await user.click(screen.getByRole('button', BUTTON));
    await screen.findByText('Sent — starting the role-play');
    await expect(container).toHaveNoViolations();
  });
});
