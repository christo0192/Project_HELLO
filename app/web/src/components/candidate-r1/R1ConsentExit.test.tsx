import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { R1ConsentExit } from './R1ConsentExit';

const QUESTION = 'This ends your interview now and it cannot be rejoined.';
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
});
afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function exit(props: Partial<Parameters<typeof R1ConsentExit>[0]> = {}) {
  const onConfirm = vi.fn();
  const view = render(
    <R1ConsentExit kind="withdraw" question={QUESTION} busy={false} onConfirm={onConfirm} {...props} />,
  );
  return { ...view, onConfirm };
}

describe('the way out of a consent, as the other screens use it', () => {
  it('asks first and does nothing to focus or scroll', async () => {
    const user = userEvent.setup();
    const { onConfirm } = exit();
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    expect(screen.getByRole('group', { name: 'Withdraw consent' })).toBeVisible();
    // Unchanged for the screens that are not inside a scrolling card.
    expect(document.body).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Keep my consent' })).not.toHaveAccessibleDescription(
      QUESTION,
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('the way out of a consent inside a card that scrolls (keepInView)', () => {
  it('brings the question into view and puts the keyboard on the safe choice', async () => {
    const user = userEvent.setup();
    const { onConfirm } = exit({ keepInView: true });
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    const group = screen.getByRole('group', { name: 'Withdraw consent' });
    expect(scrollIntoView.mock.contexts).toContain(group);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    const keep = screen.getByRole('button', { name: 'Keep my consent' });
    expect(keep).toHaveFocus();
    expect(keep).toHaveAccessibleDescription(QUESTION);
    // Focus is on the choice that changes nothing: a stray Enter cannot withdraw.
    await user.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Withdraw my consent' })).toHaveFocus();
  });

  it('works for a decline as well', async () => {
    const user = userEvent.setup();
    exit({ kind: 'decline', keepInView: true });
    await user.click(screen.getByRole('button', { name: 'I do not want to take this interview' }));
    expect(screen.getByRole('button', { name: 'Keep my invitation' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Keep my invitation' }));
    expect(screen.getByRole('button', { name: 'I do not want to take this interview' })).toHaveFocus();
  });

  it('confirms only on the explicit choice', async () => {
    const user = userEvent.setup();
    const { onConfirm } = exit({ keepInView: true });
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    await user.click(
      screen.getAllByRole('button', { name: 'Withdraw my consent' })[0] as HTMLElement,
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not take the focus when it is first shown, only when it is opened', () => {
    exit({ keepInView: true });
    expect(document.body).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('brings a failure into view, and says nothing on screens that did not ask', () => {
    const asking = exit({ keepInView: true, error: 'We could not record your withdrawal.' });
    expect(scrollIntoView.mock.contexts).toContain(screen.getByRole('alert'));
    asking.unmount();
    scrollIntoView.mockClear();
    exit({ error: 'We could not record your withdrawal.' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('has no accessibility violations with the question open', async () => {
    const user = userEvent.setup();
    const { container } = exit({ keepInView: true });
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    await expect(container).toHaveNoViolations();
  });
});
