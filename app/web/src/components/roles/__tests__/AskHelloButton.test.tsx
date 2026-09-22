/**
 * Ask Hello — the button, and the progress it reports.
 *
 * The reason this component exists in the shape it does: a draft runs v4-pro
 * up to three times at 133-206s a call, so it can legitimately be working for
 * the better part of ten minutes. The tests below are mostly about that — that
 * the label tracks the SERVER's phase rather than a timer, that a user can get
 * out, and that a draft the server refused never reaches the form.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApi = { draftRole: vi.fn() };
vi.mock('../../../api', () => ({
  draftRole: (...args: unknown[]) => mockApi.draftRole(...args),
  ApiError: class extends Error {},
}));

import { AskHelloButton } from '../AskHelloButton';

const OUTCOME = {
  draft: {
    jd: 'A job description.',
    required_skills: ['Sales'],
    screening_template: [{ id: 'q1', question: 'What do you do?', weight: 1 }],
  },
  attempts: 1,
  repaired: [],
};

function setup(props: Partial<React.ComponentProps<typeof AskHelloButton>> = {}) {
  const onDrafted = vi.fn();
  const onError = vi.fn();
  const view = render(
    <AskHelloButton
      jobRole="Sales Advisor"
      onDrafted={onDrafted}
      onError={onError}
      wouldOverwrite={false}
      {...props}
    />,
  );
  return { onDrafted, onError, ...view };
}

describe('AskHelloButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.draftRole.mockResolvedValue(OUTCOME);
  });

  it('is DISABLED without a job role — there is nothing to draft from', () => {
    setup({ jobRole: '   ' });
    expect(screen.getByRole('button', { name: /Ask Hello/ })).toBeDisabled();
  });

  it('hands the drafted role to the form', async () => {
    const { onDrafted } = setup();
    screen.getByRole('button', { name: /Ask Hello/ }).click();
    await waitFor(() => expect(onDrafted).toHaveBeenCalledWith(OUTCOME));
  });

  it('REPORTS THE SERVER’S PHASE, not a spinner', async () => {
    // The whole reason the endpoint streams. A generic "Loading…" over ten
    // minutes is indistinguishable from a hang.
    let emit: (p: unknown) => void = () => {};
    mockApi.draftRole.mockImplementation((_role: string, opts: { onProgress: (p: unknown) => void }) => {
      emit = opts.onProgress;
      return new Promise(() => {}); // never settles: we are testing the wait
    });
    setup();
    screen.getByRole('button', { name: /Ask Hello/ }).click();

    const status = await screen.findByRole('status');
    act(() => emit({ phase: 'drafting', attempt: 1, maxAttempts: 3 }));
    expect(status.textContent).toContain('Writing the role');
    expect(status.textContent).toContain('1 of 3');

    act(() => emit({ phase: 'repairing', attempt: 2, maxAttempts: 3, rejected: 2 }));
    // Names WHAT is wrong and HOW MANY — "attempt 2" alone would not explain
    // why a draft is taking a second pass.
    expect(status.textContent).toContain('Rephrasing 2 questions');
    expect(status.textContent).toContain("won't read aloud");
  });

  it('singularises one rejected question', async () => {
    let emit: (p: unknown) => void = () => {};
    mockApi.draftRole.mockImplementation((_r: string, o: { onProgress: (p: unknown) => void }) => {
      emit = o.onProgress;
      return new Promise(() => {});
    });
    setup();
    screen.getByRole('button', { name: /Ask Hello/ }).click();
    const status = await screen.findByRole('status');
    act(() => emit({ phase: 'repairing', attempt: 2, maxAttempts: 3, rejected: 1 }));
    expect(status.textContent).toContain('Rephrasing 1 question the');
  });

  it('offers a CANCEL and aborts the request with it', async () => {
    // Without this the only way out of a ten-minute draft is to leave the page.
    let signal: AbortSignal | undefined;
    mockApi.draftRole.mockImplementation((_r: string, o: { signal: AbortSignal }) => {
      signal = o.signal;
      return new Promise(() => {});
    });
    setup();
    screen.getByRole('button', { name: /Ask Hello/ }).click();

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    cancel.click();
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('does NOT report an abort as a failure', async () => {
    // The user's own doing is not an error to show them.
    const abort = new DOMException('aborted', 'AbortError');
    mockApi.draftRole.mockRejectedValue(abort);
    const { onError, onDrafted } = setup();
    screen.getByRole('button', { name: /Ask Hello/ }).click();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ask Hello/ })).not.toBeDisabled(),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(onDrafted).not.toHaveBeenCalled();
  });

  it('surfaces a real failure and applies NOTHING', async () => {
    mockApi.draftRole.mockRejectedValue(new Error('could not phrase them'));
    const { onError, onDrafted } = setup();
    screen.getByRole('button', { name: /Ask Hello/ }).click();
    await waitFor(() => expect(onError).toHaveBeenCalledWith('could not phrase them'));
    // A refused draft must never half-fill the form.
    expect(onDrafted).not.toHaveBeenCalled();
  });

  it('ASKS BEFORE OVERWRITING work already in the form', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onDrafted } = setup({ wouldOverwrite: true });
    screen.getByRole('button', { name: /Ask Hello/ }).click();

    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(mockApi.draftRole).not.toHaveBeenCalled());
    expect(onDrafted).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('does not ask when there is nothing to lose', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({ wouldOverwrite: false });
    screen.getByRole('button', { name: /Ask Hello/ }).click();
    await waitFor(() => expect(mockApi.draftRole).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('keeps the live region MOUNTED while idle', async () => {
    // A region created at the same moment its content appears is not reliably
    // announced — the first phase change would be silent.
    setup();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
