/**
 * MetricAskHello — Ask Hello on the Scorebar's Add-a-metric form.
 *
 * Rendered on its own, with the form's state passed in as the `draft` prop
 * (a rerender is "the admin typed"), so these pin the component's contract
 * independently of the form that hosts it:
 *   - inert until the name has a non-space character (aria-disabled, no-op);
 *   - sends the trimmed name and description (a blank description as null);
 *   - on success hands all five strings to `onApply` and announces it;
 *   - busy in place, focus stays on the button, and busy is SAID ONCE (the
 *     button's name never changes; the live region carries it);
 *   - asks before replacing text the admin already wrote (confirm + cancel);
 *   - discards a draft that returns after the form changed, or after unmount;
 *   - clears its status and error when the host resets the form (resetKey);
 *   - errors inline, in plain English;
 *   - never saves anything (its only API call is the draft).
 * The wiring into ScorebarSection is pinned in ScorebarSection.test.tsx.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { api, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    api: {
      draftMetricRubric: vi.fn(),
      createScorecardMetric: vi.fn(),
      updateScorecardMetric: vi.fn(),
    },
    ApiError,
  };
});

vi.mock('../../../api', () => ({ api, ApiError }));

import { MetricAskHello, type MetricAskHelloDraft } from '../MetricAskHello';

const HELLO_DRAFT = {
  default_instruction: 'Look for concrete examples of ownership. Use only what the candidate said.',
  rubric: {
    1: 'No example of taking responsibility.',
    2: 'A general claim with no example.',
    3: 'A specific example with a clear outcome.',
    4: 'Several specific examples, including owning a mistake.',
  },
};

const ASK_NAME = /^Ask Hello to draft the scoring instruction and rubric$/;
const DRAFTING = 'Hello is drafting the scoring instruction and rubric…';
const DRAFTED = 'Hello drafted the scoring instruction and rubric — review before creating.';
const REPLACE_TITLE = "Replace what you've written?";
const REPLACE_CONFIRM = "Replace with Hello's draft";

function form(over: Partial<Omit<MetricAskHelloDraft, 'rubric'>> & {
  rubric?: Partial<MetricAskHelloDraft['rubric']>;
} = {}): MetricAskHelloDraft {
  return {
    name: over.name ?? '',
    description: over.description ?? '',
    instruction: over.instruction ?? '',
    rubric: { 1: '', 2: '', 3: '', 4: '', ...over.rubric },
  };
}

function renderAsk(draft: MetricAskHelloDraft) {
  const onApply = vi.fn();
  const utils = render(<MetricAskHello idPrefix="t" draft={draft} onApply={onApply} />);
  return {
    ...utils,
    onApply,
    user: userEvent.setup(),
    /** The admin typed: the host re-renders with the new form state. */
    retype: (next: MetricAskHelloDraft, resetKey?: number) =>
      utils.rerender(
        <MetricAskHello idPrefix="t" draft={next} onApply={onApply} resetKey={resetKey} />,
      ),
  };
}

/** Drafting has started: the button reports busy (its name does not change). */
async function waitForBusy() {
  await waitFor(() => expect(askButton()).toHaveAttribute('aria-busy', 'true'));
  return askButton();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function askButton() {
  return screen.getByRole('button', { name: ASK_NAME });
}

function liveRegion() {
  return document.querySelector('[data-ask-hello-status]') as HTMLElement;
}

beforeEach(() => {
  // `restoreMocks` does not clear a hoisted `vi.fn()`'s call log, and every
  // "not called" below depends on a clean one.
  vi.clearAllMocks();
  api.draftMetricRubric.mockResolvedValue(HELLO_DRAFT);
});

describe('MetricAskHello — availability', () => {
  it('is inert until the name has a non-space character — aria-disabled, and a press is a no-op', async () => {
    const { user, retype } = renderAsk(form());
    expect(askButton()).toHaveAttribute('aria-disabled', 'true');
    // Not `disabled`: a real disabled button drops keyboard focus to <body>.
    expect(askButton()).not.toBeDisabled();
    await user.click(askButton());
    expect(api.draftMetricRubric).not.toHaveBeenCalled();

    retype(form({ name: '   ' }));
    expect(askButton()).toHaveAttribute('aria-disabled', 'true');
    await user.click(askButton());
    expect(api.draftMetricRubric).not.toHaveBeenCalled();

    retype(form({ name: 'Ownership' }));
    expect(askButton()).toHaveAttribute('aria-disabled', 'false');
  });

  it('says why it is unavailable, and ties that hint to the button', () => {
    renderAsk(form());
    const hint = screen.getByText('Add a name and Hello can draft the instruction and rubric.');
    expect(askButton()).toHaveAttribute('aria-describedby', hint.id);
  });

  it('keeps the visible label inside the accessible name (SC 2.5.3)', () => {
    renderAsk(form({ name: 'Ownership' }));
    expect(askButton()).toHaveTextContent('Ask Hello');
    expect(askButton()).toHaveTextContent('✦');
  });
});

describe('MetricAskHello — drafting', () => {
  it('sends the trimmed name, and a blank description as null', async () => {
    const { user } = renderAsk(form({ name: '  Ownership ', description: '   ' }));
    await user.click(askButton());
    await waitFor(() =>
      expect(api.draftMetricRubric).toHaveBeenCalledWith({ name: 'Ownership', description: null }),
    );
  });

  it('sends the trimmed description when there is one', async () => {
    const { user } = renderAsk(form({ name: 'Ownership', description: '  Takes responsibility  ' }));
    await user.click(askButton());
    await waitFor(() =>
      expect(api.draftMetricRubric).toHaveBeenCalledWith({
        name: 'Ownership',
        description: 'Takes responsibility',
      }),
    );
  });

  it('hands all five strings to onApply, announces it politely, and saves nothing', async () => {
    const { user, onApply } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(HELLO_DRAFT.default_instruction, HELLO_DRAFT.rubric);
    expect(liveRegion()).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion()).toHaveTextContent(DRAFTED);
    expect(api.draftMetricRubric).toHaveBeenCalledTimes(1);
    expect(api.createScorecardMetric).not.toHaveBeenCalled();
    expect(api.updateScorecardMetric).not.toHaveBeenCalled();
  });

  it('shows a busy state in place while drafting, and ignores a second press', async () => {
    const pending = deferred<typeof HELLO_DRAFT>();
    api.draftMetricRubric.mockReturnValue(pending.promise);
    const { user, onApply } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());

    const busy = await waitForBusy();
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveTextContent('◐');
    // The status line says it — on screen AND to a screen reader.
    expect(liveRegion()).toHaveTextContent(DRAFTING);

    await user.click(busy);
    expect(api.draftMetricRubric).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(HELLO_DRAFT));
    await waitFor(() => expect(askButton()).toHaveAttribute('aria-busy', 'false'));
    expect(askButton()).toHaveTextContent('✦');
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('says "busy" ONCE: the name and label never change, only the live region speaks', async () => {
    // A focused control whose name changes is re-announced; the old busy
    // `aria-label` equalled the live-region sentence, so it was read twice.
    const pending = deferred<typeof HELLO_DRAFT>();
    api.draftMetricRubric.mockReturnValue(pending.promise);
    const { user } = renderAsk(form({ name: 'Ownership' }));
    askButton().focus();
    await user.keyboard('{Enter}');

    const busy = await waitForBusy();
    // Same accessible name, same visible label (so SC 2.5.3 holds while busy).
    expect(busy).toHaveAccessibleName(ASK_NAME);
    expect(busy).toHaveTextContent(/^◐\s*Ask Hello$/);
    expect(busy).toHaveFocus();
    // The sentence exists in exactly one place: the visible live region.
    const said = screen.getAllByText(DRAFTING);
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(liveRegion());
    expect(liveRegion()).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion().querySelector('.sr-only')).toBeNull();

    await act(async () => pending.resolve(HELLO_DRAFT));
  });

  it('keeps keyboard focus on the button through the draft and the fill', async () => {
    const pending = deferred<typeof HELLO_DRAFT>();
    api.draftMetricRubric.mockReturnValue(pending.promise);
    const { user } = renderAsk(form({ name: 'Ownership' }));
    askButton().focus();
    await user.keyboard('{Enter}');
    expect(await waitForBusy()).toHaveFocus();
    await act(async () => pending.resolve(HELLO_DRAFT));
    await screen.findByText(DRAFTED);
    expect(askButton()).toHaveFocus();
  });

  it('discards a draft that returns after the form changed, rather than overwrite the edit', async () => {
    const pending = deferred<typeof HELLO_DRAFT>();
    api.draftMetricRubric.mockReturnValue(pending.promise);
    const { user, onApply, retype } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());
    await waitForBusy();
    retype(form({ name: 'Ownership', instruction: 'Typed during the wait.' }));
    await act(async () => pending.resolve(HELLO_DRAFT));
    expect(liveRegion()).toHaveTextContent(
      'The form changed while Hello was drafting, so the draft was not applied.',
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies nothing when the draft lands after it UNMOUNTED — it can no longer see the form', async () => {
    // The host's list reload swaps the form out and back. The old instance's
    // copy of the form froze at unmount, so "unchanged" would be a lie about
    // whatever the admin typed into the new one.
    const pending = deferred<typeof HELLO_DRAFT>();
    api.draftMetricRubric.mockReturnValue(pending.promise);
    const { user, onApply, unmount } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());
    await waitForBusy();
    unmount();
    await act(async () => pending.resolve(HELLO_DRAFT));
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('MetricAskHello — the host resets the form (resetKey)', () => {
  it('clears "Hello drafted…" so an empty form does not claim a draft it no longer has', async () => {
    const { user, retype } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());
    await screen.findByText(DRAFTED);

    // The admin pressed Create: the host empties the form and bumps the key.
    retype(form(), 1);

    expect(liveRegion()).toHaveTextContent(/^$/);
    expect(screen.queryByText(DRAFTED)).not.toBeInTheDocument();
    // Only the empty-form hint remains, with nothing contradicting it.
    expect(
      screen.getByText('Add a name and Hello can draft the instruction and rubric.'),
    ).toBeInTheDocument();
  });

  it('clears an error too', async () => {
    api.draftMetricRubric.mockRejectedValue(new ApiError('Too many requests', 429));
    const { user, retype } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());
    await screen.findByRole('alert');

    retype(form(), 1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the status on an ordinary re-render — only a NEW key resets', async () => {
    const { user, retype } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());
    await screen.findByText(DRAFTED);
    retype(form({ name: 'Ownership' }), 0);
    expect(liveRegion()).toHaveTextContent(DRAFTED);
  });
});

describe('MetricAskHello — replacing what the admin already wrote', () => {
  it('asks first, and drafts nothing until the admin confirms', async () => {
    const { user, onApply } = renderAsk(form({ name: 'Ownership', instruction: 'My own.' }));
    await user.click(askButton());
    const dialog = await screen.findByRole('dialog', { name: REPLACE_TITLE });
    expect(api.draftMetricRubric).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: REPLACE_CONFIRM }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(api.draftMetricRubric).toHaveBeenCalledTimes(1);
    // Focus came back to the button the dialog was opened from.
    expect(askButton()).toHaveFocus();
  });

  it('renders the dialog OUTSIDE the form, at <body> — a `.glass` ancestor would clip a fixed overlay', async () => {
    const { container, user } = renderAsk(form({ name: 'Ownership', instruction: 'My own.' }));
    await user.click(askButton());
    const dialog = await screen.findByRole('dialog', { name: REPLACE_TITLE });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('"Keep my text" closes the dialog, drafts nothing, and applies nothing', async () => {
    const { user, onApply } = renderAsk(form({ name: 'Ownership', instruction: 'My own.' }));
    await user.click(askButton());
    const dialog = await screen.findByRole('dialog', { name: REPLACE_TITLE });
    await user.click(within(dialog).getByRole('button', { name: 'Keep my text' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.draftMetricRubric).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(askButton()).toHaveFocus();
  });

  it('Escape is a cancel too', async () => {
    const { user } = renderAsk(form({ name: 'Ownership', instruction: 'My own.' }));
    await user.click(askButton());
    await screen.findByRole('dialog', { name: REPLACE_TITLE });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.draftMetricRubric).not.toHaveBeenCalled();
  });

  it('text in ONE rubric level is enough to ask', async () => {
    const { user } = renderAsk(form({ name: 'Ownership', rubric: { 3: 'Mine' } }));
    await user.click(askButton());
    expect(await screen.findByRole('dialog', { name: REPLACE_TITLE })).toBeInTheDocument();
    expect(api.draftMetricRubric).not.toHaveBeenCalled();
  });

  it('whitespace alone is not "text" — no dialog', async () => {
    const { user } = renderAsk(form({ name: 'Ownership', instruction: '   ', rubric: { 2: ' ' } }));
    await user.click(askButton());
    await waitFor(() => expect(api.draftMetricRubric).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a description alone does not count — it is an input, not something Hello replaces', async () => {
    const { user } = renderAsk(form({ name: 'Ownership', description: 'Takes responsibility' }));
    await user.click(askButton());
    await waitFor(() => expect(api.draftMetricRubric).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('MetricAskHello — errors, inline and in plain English', () => {
  async function askAndFail(err: unknown) {
    api.draftMetricRubric.mockRejectedValue(err);
    const utils = renderAsk(form({ name: 'Ownership' }));
    await utils.user.click(askButton());
    return { alert: await screen.findByRole('alert'), onApply: utils.onApply };
  }

  it("a 422 shows the server's operator-facing reason, and applies nothing", async () => {
    const { alert, onApply } = await askAndFail(
      new ApiError(
        "Hello's draft came out longer than the form allows. Try again, or write it yourself.",
        422,
      ),
    );
    expect(alert).toHaveTextContent("Hello's draft came out longer than the form allows.");
    expect(onApply).not.toHaveBeenCalled();
    // Usable again for a retry.
    expect(askButton()).toHaveAttribute('aria-disabled', 'false');
  });

  it('a 429 says Hello is busy', async () => {
    const { alert } = await askAndFail(new ApiError('Too many requests', 429));
    expect(alert).toHaveTextContent('Hello is busy — try again in a minute.');
    expect(alert).not.toHaveTextContent('Too many requests');
  });

  it('anything else gets a plain fallback, never a raw error', async () => {
    const { alert } = await askAndFail(new ApiError('Internal server error', 500));
    expect(alert).toHaveTextContent('Hello could not draft this right now. Try again, or write it yourself.');
    expect(alert).not.toHaveTextContent('Internal server error');
  });

  it('a network failure says so without the dev-server hint', async () => {
    const { alert } = await askAndFail(
      new ApiError('Could not reach the server. Is the API running on http://localhost:8787?', 0),
    );
    expect(alert).toHaveTextContent('Hello could not be reached. Check your connection and try again.');
    expect(alert).not.toHaveTextContent('localhost');
  });

  it('never applies half a draft', async () => {
    api.draftMetricRubric.mockResolvedValue({
      default_instruction: 'Only this.',
      rubric: { 1: 'a', 2: 'b', 3: '', 4: 'd' },
    });
    const { user, onApply } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Hello could not draft this right now.');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('a new attempt clears the old error', async () => {
    api.draftMetricRubric.mockRejectedValueOnce(new ApiError('Too many requests', 429));
    const { user, onApply } = renderAsk(form({ name: 'Ownership' }));
    await user.click(askButton());
    await screen.findByRole('alert');
    await user.click(askButton());
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('MetricAskHello — accessibility', () => {
  it('has no axe violations idle, unavailable, and with the replace dialog open', async () => {
    const { container, retype, user } = renderAsk(form());
    await expect(container).toHaveNoViolations();
    retype(form({ name: 'Ownership', instruction: 'Mine.' }));
    await expect(container).toHaveNoViolations();
    await user.click(askButton());
    const dialog = await screen.findByRole('dialog', { name: REPLACE_TITLE });
    // The overlay is portalled to <body>, so it is checked where it lives.
    await expect(dialog.parentElement as HTMLElement).toHaveNoViolations();
  });
});
