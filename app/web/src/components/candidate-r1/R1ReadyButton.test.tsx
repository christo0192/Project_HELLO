import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api-client';
import {
  R1ReadyButton,
  R1_READY_RATE_LIMITED_RETRY_MS,
  R1_READY_RETRY_MS,
} from './R1ReadyButton';
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

  describe('after a failure', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Fake timers, but the promise queue still runs: what `userEvent` and `await` need. */
    function fakeTimers() {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    }

    it('says what to do instead, and can be pressed again once the wait is over', async () => {
      const user = fakeTimers();
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

      // Hammering a refused button only makes each refusal cost the server more: it waits.
      const button = screen.getByRole('button', BUTTON);
      expect(button).toHaveAttribute('aria-disabled', 'true');
      await user.click(button);
      expect(onReady).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(R1_READY_RETRY_MS - 100);
      });
      await user.click(screen.getByRole('button', BUTTON));
      expect(onReady).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByRole('button', BUTTON)).not.toHaveAttribute('aria-disabled');
      // The message stays: it is still what the candidate should do.
      expect(screen.getByRole('alert')).toBeVisible();

      await user.click(screen.getByRole('button', BUTTON));
      expect(onReady).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('Sent — starting the role-play')).toBeVisible();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('waits longer when the server said it is being asked too often', async () => {
      const user = fakeTimers();
      const onReady = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new ApiError('http_429', 429))
        .mockResolvedValue(undefined);
      render(<R1ReadyButton onReady={onReady} />);
      await user.click(screen.getByRole('button', BUTTON));
      await screen.findByRole('alert');
      expect(R1_READY_RATE_LIMITED_RETRY_MS).toBeGreaterThan(R1_READY_RETRY_MS);
      act(() => {
        vi.advanceTimersByTime(R1_READY_RETRY_MS + 100);
      });
      expect(screen.getByRole('button', BUTTON)).toHaveAttribute('aria-disabled', 'true');
      act(() => {
        vi.advanceTimersByTime(R1_READY_RATE_LIMITED_RETRY_MS - R1_READY_RETRY_MS);
      });
      expect(screen.getByRole('button', BUTTON)).not.toHaveAttribute('aria-disabled');
    });

    it('does not run its timer after it has been removed', async () => {
      const user = fakeTimers();
      const onReady = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('x'));
      const { unmount } = render(<R1ReadyButton onReady={onReady} />);
      await user.click(screen.getByRole('button', BUTTON));
      await screen.findByRole('alert');
      unmount();
      // Would set state on an unmounted component if the timer outlived it.
      act(() => {
        vi.advanceTimersByTime(R1_READY_RATE_LIMITED_RETRY_MS + 1_000);
      });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('tells the page when it is removed while it holds the keyboard focus, and only then', () => {
    const onRemovedWithFocus = vi.fn();
    const first = render(<R1ReadyButton onReady={vi.fn()} onRemovedWithFocus={onRemovedWithFocus} />);
    screen.getByRole('button', BUTTON).focus();
    first.unmount();
    expect(onRemovedWithFocus).toHaveBeenCalledTimes(1);

    onRemovedWithFocus.mockClear();
    const second = render(<R1ReadyButton onReady={vi.fn()} onRemovedWithFocus={onRemovedWithFocus} />);
    expect(screen.getByRole('button', BUTTON)).not.toHaveFocus();
    second.unmount();
    expect(onRemovedWithFocus).not.toHaveBeenCalled();
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

  it('has no accessibility violations idle, failed (waiting), failed (ready again) or sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onReady = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('x'))
        .mockResolvedValue(undefined);
      const { container } = render(<R1ReadyButton onReady={onReady} />);
      await expect(container).toHaveNoViolations();
      await user.click(screen.getByRole('button', BUTTON));
      await screen.findByRole('alert');
      await expect(container).toHaveNoViolations();
      act(() => {
        vi.advanceTimersByTime(R1_READY_RETRY_MS + 100);
      });
      await expect(container).toHaveNoViolations();
      await user.click(screen.getByRole('button', BUTTON));
      await screen.findByText('Sent — starting the role-play');
      await expect(container).toHaveNoViolations();
    } finally {
      vi.useRealTimers();
    }
  });
});
