/**
 * Ask Hello — the button, and the progress it reports.
 *
 * The reason this component exists in the shape it does: a draft runs v4-pro
 * up to three times at 133-206s a call, so it can legitimately be working for
 * the better part of ten minutes. It therefore starts a JOB and polls it,
 * rather than holding a request open. The tests below are mostly about that
 * wait — that the label tracks the SERVER's phase rather than a timer, that a
 * user can get out, that a refused draft never reaches the form, and that a
 * job which lands after the form has gone cannot write into a dead component.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockApi = {
  startRoleDraft: vi.fn(),
  // MISSING FROM THIS MOCK FOR A WHOLE COMMIT, which is how a dead endpoint
  // shipped. The component calls it on mount; with the key absent it was
  // `undefined`, the resume effect threw a TypeError, and the deliberately
  // empty catch that exists for "no draft to recover" swallowed it. Sixteen
  // green tests, and the resume path never ran once.
  getActiveRoleDraft: vi.fn(),
  getRoleDraft: vi.fn(),
  cancelRoleDraft: vi.fn(),
};
vi.mock('../../../api', () => ({
  api: {
    startRoleDraft: (...a: unknown[]) => mockApi.startRoleDraft(...a),
    getActiveRoleDraft: (...a: unknown[]) => mockApi.getActiveRoleDraft(...a),
    getRoleDraft: (...a: unknown[]) => mockApi.getRoleDraft(...a),
    cancelRoleDraft: (...a: unknown[]) => mockApi.cancelRoleDraft(...a),
  },
  ApiError: class extends Error {},
}));

import { AskHelloButton } from '../AskHelloButton';

const DRAFT = {
  jd: 'A job description.',
  required_skills: ['Sales'],
  screening_template: [{ id: 'q1', question: 'What do you do?', weight: 1 }],
};

/** A running job, optionally at a named phase. */
function running(phase: unknown = null) {
  return {
    id: 'job-1',
    job_role: 'Sales Advisor',
    status: 'running',
    phase,
    draft: null,
    attempts: 1,
    repaired: [],
    error_reason: null,
    error_message: null,
    max_attempts: 3,
    created_at: new Date().toISOString(),
  };
}

function succeeded(over: Record<string, unknown> = {}) {
  return { ...running(), status: 'succeeded', draft: DRAFT, ...over };
}

function setup(props: Partial<React.ComponentProps<typeof AskHelloButton>> = {}) {
  const onDrafted = vi.fn();
  const onError = vi.fn();
  const view = render(
    <AskHelloButton
      jobRole="Sales Advisor"
      onDrafted={onDrafted}
      onError={onError}
      wouldOverwrite={() => false}
      {...props}
    />,
  );
  return { onDrafted, onError, ...view };
}

// The SAME button in both states. Its label changes to "Asking Hello…" while a
// job runs, so a /Ask Hello/ matcher would stop finding it at exactly the
// moment the tests care most about what it is doing.
const askHello = () => screen.getByRole('button', { name: /Ask(ing)? Hello/ });

/** One poll interval, flushing whatever the tick awaited. */
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
}

describe('AskHelloButton', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
    mockApi.startRoleDraft.mockResolvedValue(running());
    mockApi.getRoleDraft.mockResolvedValue(succeeded());
    mockApi.cancelRoleDraft.mockResolvedValue({ cancelled: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cannot be started without a job role — there is nothing to draft from', async () => {
    setup({ jobRole: '   ' });
    // `aria-disabled`, NOT `disabled`: a disabled button loses keyboard focus
    // the instant it is pressed, dropping the user to <body> exactly when
    // Cancel appears. The handler is what refuses.
    expect(askHello()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => askHello().click());
    expect(mockApi.startRoleDraft).not.toHaveBeenCalled();
  });

  it('hands the drafted role, the repairs AND THE JOB’S OWN job role to the form', async () => {
    // The third argument is the point: the field stays editable for the ten
    // minutes a draft runs, so the form cannot assume what it currently holds
    // is what was drafted.
    mockApi.getRoleDraft.mockResolvedValue(
      succeeded({ job_role: 'Sales Advisr', repaired: ['q2'] }),
    );
    const { onDrafted } = setup();
    await act(async () => askHello().click());
    await waitFor(() =>
      expect(onDrafted).toHaveBeenCalledWith(DRAFT, ['q2'], 'Sales Advisr'),
    );
  });

  it('REPORTS THE SERVER’S PHASE, not a spinner', async () => {
    // The whole reason the job persists a phase. A generic "Loading…" over ten
    // minutes is indistinguishable from a hang.
    mockApi.getRoleDraft.mockResolvedValue(
      running({ phase: 'drafting', attempt: 1, maxAttempts: 3 }),
    );
    setup();
    await act(async () => askHello().click());

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('Writing the role'));
    expect(status.textContent).toContain('1 of 3');

    mockApi.getRoleDraft.mockResolvedValue(
      running({ phase: 'repairing', attempt: 2, maxAttempts: 3, rejected: 2 }),
    );
    await poll();
    // Names WHAT is wrong and HOW MANY — "attempt 2" alone would not explain
    // why a draft is taking a second pass.
    expect(status.textContent).toContain('Rephrasing 2 questions');
    expect(status.textContent).toContain("won't read aloud");
  });

  it('singularises one rejected question', async () => {
    mockApi.getRoleDraft.mockResolvedValue(
      running({ phase: 'repairing', attempt: 2, maxAttempts: 3, rejected: 1 }),
    );
    setup();
    await act(async () => askHello().click());
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('Rephrasing 1 question the'));
  });

  it('names the UNREADABLE-ANSWER retry as its own phase', async () => {
    // A reread is not a repair: nothing was rejected, the model's reply could
    // not be parsed at all. Reporting it as "rephrasing 0 questions" would be
    // a lie about what is happening.
    mockApi.getRoleDraft.mockResolvedValue(
      running({ phase: 'rereading', attempt: 2, maxAttempts: 3 }),
    );
    setup();
    await act(async () => askHello().click());
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('unreadable'));
    expect(status.textContent).toContain('2 of 3');
  });

  it('keeps the elapsed counter OUT of the live region', async () => {
    // `role="status"` is implicitly atomic, so a per-second counter inside it
    // re-announces the whole sentence ~600 times over a long draft, with the
    // polite queue never draining and nothing else on the page audible.
    mockApi.getRoleDraft.mockResolvedValue(running());
    setup();
    await act(async () => askHello().click());
    const status = await screen.findByRole('status');
    const elapsed = document.querySelector('[data-ask-hello-elapsed]');
    expect(elapsed).not.toBeNull();
    expect(elapsed).toHaveAttribute('aria-hidden', 'true');
    expect(status.contains(elapsed)).toBe(false);
  });

  it('offers a CANCEL, and it STOPS THE JOB rather than just the spinner', async () => {
    // Aborting a fetch would leave v4-pro running and billing for ten minutes.
    mockApi.getRoleDraft.mockResolvedValue(running());
    setup();
    await act(async () => askHello().click());

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await act(async () => cancel.click());
    await waitFor(() => expect(mockApi.cancelRoleDraft).toHaveBeenCalledWith('job-1'));
  });

  it('does NOT report a cancellation as a failure', async () => {
    // The user's own doing is not an error to show them.
    mockApi.getRoleDraft.mockResolvedValue({ ...running(), status: 'cancelled' });
    const { onError, onDrafted } = setup();
    await act(async () => askHello().click());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument(),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(onDrafted).not.toHaveBeenCalled();
  });

  it('surfaces a failed job and applies NOTHING', async () => {
    mockApi.getRoleDraft.mockResolvedValue({
      ...running(),
      status: 'failed',
      error_message: 'could not phrase them',
    });
    const { onError, onDrafted } = setup();
    await act(async () => askHello().click());
    await waitFor(() => expect(onError).toHaveBeenCalledWith('could not phrase them'));
    // A refused draft must never half-fill the form.
    expect(onDrafted).not.toHaveBeenCalled();
  });

  it('SURVIVES A FAILED POLL — one blip is not a failed draft', async () => {
    // The job is running server-side regardless of whether one GET landed.
    // Treating a dropped poll as a failure would throw away a nine-minute run.
    mockApi.getRoleDraft.mockRejectedValueOnce(new Error('network'));
    mockApi.getRoleDraft.mockResolvedValue(succeeded());
    const { onError, onDrafted } = setup();
    await act(async () => askHello().click());
    await poll();
    await waitFor(() => expect(onDrafted).toHaveBeenCalled());
    expect(onError).not.toHaveBeenCalled();
  });

  it('STOPS POLLING once unmounted', async () => {
    // A ten-minute job outlives the form. Without the teardown this keeps
    // requesting forever and then writes into a component that is gone.
    mockApi.getRoleDraft.mockResolvedValue(running());
    const { unmount } = setup();
    await act(async () => askHello().click());
    await waitFor(() => expect(mockApi.getRoleDraft).toHaveBeenCalled());
    unmount();
    const after = mockApi.getRoleDraft.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockApi.getRoleDraft.mock.calls.length).toBe(after);
  });

  it('ASKS BEFORE OVERWRITING work already in the form', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onDrafted } = setup({ wouldOverwrite: () => true });
    await act(async () => askHello().click());

    expect(confirm).toHaveBeenCalled();
    expect(mockApi.startRoleDraft).not.toHaveBeenCalled();
    expect(onDrafted).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('does not ask when there is nothing to lose', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({ wouldOverwrite: () => false });
    await act(async () => askHello().click());
    await waitFor(() => expect(mockApi.startRoleDraft).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('does not start a SECOND job while one is running', async () => {
    // Each start burns up to three v4-pro calls; a double click would double it.
    mockApi.getRoleDraft.mockResolvedValue(running());
    setup();
    await act(async () => askHello().click());
    await waitFor(() => expect(askHello()).toHaveAttribute('aria-disabled', 'true'));
    await act(async () => askHello().click());
    expect(mockApi.startRoleDraft).toHaveBeenCalledTimes(1);
  });

  it('reports a start that never got off the ground', async () => {
    mockApi.startRoleDraft.mockRejectedValue(new Error('Hello is not configured.'));
    const { onError } = setup();
    await act(async () => askHello().click());
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Hello is not configured.'));
    // And the button comes back, rather than staying stuck at "Asking Hello…".
    expect(askHello()).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('PICKS UP A JOB THAT IS ALREADY RUNNING', async () => {
    // The whole reason the job is a row. Without this a refresh abandoned a
    // running draft: it kept billing, its result landed in a row no endpoint
    // could name, and the operator's only move was to start a second one.
    mockApi.getActiveRoleDraft.mockResolvedValue({
      active: { ...running({ phase: 'repairing', attempt: 2, maxAttempts: 3, rejected: 1 }), id: 'job-live' },
    });
    mockApi.getRoleDraft.mockResolvedValue(
      running({ phase: 'repairing', attempt: 2, maxAttempts: 3, rejected: 1 }),
    );
    setup();

    await waitFor(() => expect(mockApi.getRoleDraft).toHaveBeenCalledWith('job-live'));
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('Rephrasing 1 question'));
    // ...and it did NOT start a new one.
    expect(mockApi.startRoleDraft).not.toHaveBeenCalled();
  });

  it('counts elapsed from when the JOB started, not from the resume', async () => {
    // A five-minute-old draft reading "3s elapsed" is worse than no counter:
    // it says the wait has barely begun at the moment it is nearly over.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    mockApi.getActiveRoleDraft.mockResolvedValue({
      active: { ...running(), id: 'job-live', created_at: fiveMinutesAgo },
    });
    mockApi.getRoleDraft.mockResolvedValue(running());
    setup();

    await waitFor(() => {
      const el = document.querySelector('[data-ask-hello-elapsed]');
      expect(el?.textContent).toMatch(/5m/);
    });
  });

  it('does not resume when there is nothing running', async () => {
    mockApi.getActiveRoleDraft.mockResolvedValue({ active: null });
    setup();
    await waitFor(() => expect(mockApi.getActiveRoleDraft).toHaveBeenCalled());
    expect(mockApi.getRoleDraft).not.toHaveBeenCalled();
    expect(askHello()).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('survives a resume lookup that FAILS', async () => {
    // A convenience, not a precondition: the button must still work.
    mockApi.getActiveRoleDraft.mockRejectedValue(new Error('network'));
    const { onError } = setup();
    await waitFor(() => expect(mockApi.getActiveRoleDraft).toHaveBeenCalled());
    expect(onError).not.toHaveBeenCalled();
    await act(async () => askHello().click());
    await waitFor(() => expect(mockApi.startRoleDraft).toHaveBeenCalled());
  });

  it('TELLS THE OPERATOR when a cancel did not reach the server', async () => {
    // "Stops the spending, not just the spinner" holds only if the request
    // lands. A swallowed failure means v4-pro runs on while the UI says it
    // stopped.
    mockApi.getRoleDraft.mockResolvedValue(running());
    mockApi.cancelRoleDraft.mockRejectedValue(new Error('offline'));
    const { onError } = setup();
    await act(async () => askHello().click());
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await act(async () => cancel.click());
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('may not have stopped')),
    );
  });

  it('RETURNS FOCUS to the button before Cancel unmounts', async () => {
    // Cancel is the element being removed. A keyboard user standing on it
    // when it disappears lands on <body>, and the next Tab restarts from the
    // top of the page — the same failure `aria-disabled` avoids on the main
    // button, reintroduced two elements away. A review deleted `returnFocus`
    // and the suite stayed green.
    mockApi.getRoleDraft.mockResolvedValue(running());
    setup();
    await act(async () => askHello().click());
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    await act(async () => cancel.click());
    await waitFor(() => expect(document.activeElement).toBe(askHello()));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('does NOT steal focus from elsewhere on the page', async () => {
    // The guard on the other side: focus returns only when it is already
    // inside this component. An operator who tabbed on to the JD field must
    // not be yanked back when a draft settles.
    mockApi.getRoleDraft.mockResolvedValue(running());
    setup();
    await act(async () => askHello().click());
    await screen.findByRole('button', { name: 'Cancel' });

    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();

    mockApi.getRoleDraft.mockResolvedValue(succeeded());
    await poll();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('a late resume does NOT stomp a job started locally', async () => {
    // `setJobId(current => current ?? active.id)` rather than a bare set. The
    // resume lookup and a click can race, and adopting the server's answer
    // over a job this component just started would orphan the click.
    let releaseResume: (v: unknown) => void = () => {};
    mockApi.getActiveRoleDraft.mockReturnValue(
      new Promise((resolve) => {
        releaseResume = resolve;
      }),
    );
    mockApi.startRoleDraft.mockResolvedValue({ ...running(), id: 'started-here' });
    mockApi.getRoleDraft.mockResolvedValue(running());
    setup();

    await act(async () => askHello().click());
    await waitFor(() => expect(mockApi.getRoleDraft).toHaveBeenCalledWith('started-here'));

    await act(async () => {
      releaseResume({ active: { ...running(), id: 'from-server' } });
    });
    await poll();
    expect(mockApi.getRoleDraft).not.toHaveBeenCalledWith('from-server');
  });

  it('keeps the live region MOUNTED while idle', () => {
    // A region created at the same moment its content appears is not reliably
    // announced — the first phase change would be silent.
    setup();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
