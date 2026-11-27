/**
 * The public booking link card (M035 S08): what it names, the one address it shows, the copy and its two
 * ways to fail (a refused clipboard, no clipboard at all), and what it never shows. Static: the global
 * network trap fails any test in which it asks for anything.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MeetBookingsPublicLink } from '../MeetBookingsPublicLink';

const HINT = 'Paste it into the Ashby email template. Candidates can book only once public booking is switched on.';
const COPIED = 'Link copied to the clipboard.';
const REFUSED = 'Copy failed. The link is selected; press Ctrl+C (or Cmd+C) to copy it.';
const url = () => `${window.location.origin}/book`;

function show() {
  const view = render(<MeetBookingsPublicLink />);
  const live = () => {
    const regions = view.container.querySelectorAll('[aria-live]');
    expect(regions).toHaveLength(1);
    return regions[0] as HTMLElement;
  };
  return { ...view, live };
}

const field = () => screen.getByLabelText('Link for candidates') as HTMLInputElement;
const copyButton = () => screen.getByRole('button', { name: 'Copy link' });

/** What the card must never say or hold, in any state. */
function expectNothingItMustNotShow(container: HTMLElement) {
  const html = container.innerHTML;
  for (const banned of ['/book/manage', '#m=', 'meet.google']) expect(html).not.toContain(banned);
  const text = container.textContent ?? '';
  expect(text).not.toContain('_');
  expect(text).not.toMatch(/\bDex\b/);
}

/** Whether the field holds the whole address selected, ready for Ctrl+C. */
function expectSelected(input: HTMLInputElement) {
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(url().length);
}

describe('the public booking link card', () => {
  it('names itself, and shows this site\'s one public booking address, read-only, with what to do with it', () => {
    const { live } = show();
    expect(url()).toMatch(/^https?:\/\/[^/]+\/book$/);
    expect(screen.getByRole('heading', { level: 2, name: 'Public booking link' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Public booking link' })).toBeInTheDocument();
    const input = field();
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveValue(url());
    expect(input).toHaveAccessibleDescription(HINT);
    expect(screen.getByText(HINT)).toBeInTheDocument();
    // The live line is there before any press, polite, and says nothing yet.
    expect(live()).toHaveAttribute('aria-live', 'polite');
    expect(live()).not.toHaveAttribute('role');
    expect(live()).toBeEmptyDOMElement();
  });

  it('copies exactly that address once, and says so', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const { live } = show();
    await user.click(copyButton());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(url());
    expect(live()).toHaveTextContent(new RegExp(`^${COPIED.replace(/\./g, '\\.')}$`));
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it('says so, and selects the address in the field, when the clipboard is refused', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const { live } = show();
    await user.click(copyButton());
    expect(writeText).toHaveBeenCalledWith(url());
    expect(live()).toHaveTextContent(REFUSED);
    expect(screen.queryByText(COPIED)).toBeNull();
    expect(field()).toHaveFocus();
    expectSelected(field());
  });

  it('takes the same way out when the browser has no clipboard API at all', async () => {
    const user = userEvent.setup();
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    try {
      expect(navigator.clipboard).toBeUndefined();
      const { live } = show();
      await user.click(copyButton());
      expect(live()).toHaveTextContent(REFUSED);
      expect(field()).toHaveFocus();
      expectSelected(field());
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('keeps the last outcome until the next press: a refusal, then a copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    const { live } = show();
    await user.click(copyButton());
    expect(live()).toHaveTextContent(REFUSED);
    await user.click(copyButton());
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(live()).toHaveTextContent(COPIED);
    expect(live()).not.toHaveTextContent('Copy failed');
  });

  it('selects the whole address when the field takes the focus', () => {
    show();
    const input = field();
    input.setSelectionRange(3, 3);
    expect(input.selectionEnd).toBe(3);
    act(() => input.focus());
    expect(input).toHaveFocus();
    expectSelected(input);
  });

  it('never shows a manage link, a token, a Meet link, a code or the old interviewer name, in any state', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const { container, live } = show();
    expectNothingItMustNotShow(container);
    await user.click(copyButton());
    expect(live()).toHaveTextContent(COPIED);
    expectNothingItMustNotShow(container);
    writeText.mockRejectedValueOnce(new Error('denied'));
    await user.click(copyButton());
    expect(live()).toHaveTextContent(REFUSED);
    expectNothingItMustNotShow(container);
  });

  it('has no axe violations idle, copied or refused', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const { container, live } = show();
    await expect(container).toHaveNoViolations();
    await user.click(copyButton());
    expect(live()).toHaveTextContent(COPIED);
    await expect(container).toHaveNoViolations();
    writeText.mockRejectedValueOnce(new Error('denied'));
    await user.click(copyButton());
    expect(live()).toHaveTextContent(REFUSED);
    await expect(container).toHaveNoViolations();
  });

  it('asks nothing of the network, whatever is pressed', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText');
    show();
    await user.click(copyButton());
    act(() => field().focus());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
