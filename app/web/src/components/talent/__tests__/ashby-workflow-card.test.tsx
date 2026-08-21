/**
 * AshbyWorkflowCard — the read-only Ashby pipeline status card.
 *
 * Covers the invariants that make this card safe to place on the ordinary
 * candidate Overview:
 *   - a non-Ashby candidate renders NOTHING (no card, no error);
 *   - a denied/unknown read (404/403) is equally silent, so the card cannot be
 *     used to tell a missing candidate from an unowned one;
 *   - a genuine failure shows a sanitized message with no detail;
 *   - every pipeline state — pending, in progress, failed, awaiting delivery —
 *     has an accessible TEXT label, never colour alone, plus the sanitized
 *     error code when one exists;
 *   - the card introduces NO button, link, or other interactive control;
 *   - both scopes (candidate id, application link) render the same card from
 *     the same projection;
 *   - axe is clean.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AshbyWorkflowCard, AshbyWorkflowCardView } from '../AshbyWorkflowCard';
import type { AshbyCandidateWorkflow } from '../../../types';

// Hoisted so the `vi.mock` factory below (which is hoisted to the top of the
// file) can close over them.
const { mockApi, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    MockApiError,
    mockApi: {
      getCandidateAshbyWorkflow: vi.fn(),
      getAshbyScopedReviewWorkflow: vi.fn(),
    },
  };
});

vi.mock('../../../api', () => ({
  api: {
    getCandidateAshbyWorkflow: (...a: unknown[]) => mockApi.getCandidateAshbyWorkflow(...a),
    getAshbyScopedReviewWorkflow: (...a: unknown[]) => mockApi.getAshbyScopedReviewWorkflow(...a),
  },
  ApiError: MockApiError,
}));

const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
const LINK_ID = '11111111-1111-4111-8111-111111111111';

const WORKFLOW: AshbyCandidateWorkflow = {
  lifecycle: 'writeback_pending',
  terminalState: null,
  ingestionState: 'scanning',
  operations: [
    { type: 'invite_delivery', state: 'pending', errorCode: null },
    { type: 'scorecard_write', state: 'failed', errorCode: 'provider_5xx' },
  ],
  sessionStatus: 'completed',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getCandidateAshbyWorkflow.mockResolvedValue({ ok: true, workflow: WORKFLOW });
  mockApi.getAshbyScopedReviewWorkflow.mockResolvedValue({ ok: true, workflow: WORKFLOW });
});

function renderCandidateCard() {
  return render(<AshbyWorkflowCard source={{ kind: 'candidate', candidateId: CANDIDATE_ID }} />);
}

describe('AshbyWorkflowCard — absence is silent', () => {
  it('renders nothing for a candidate with no Ashby workflow', async () => {
    mockApi.getCandidateAshbyWorkflow.mockResolvedValue({ ok: true, workflow: null });
    const { container } = renderCandidateCard();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText(/ashby screening pipeline/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([404, 403])('renders nothing on a %s (unknown or unowned are the same)', async (status) => {
    mockApi.getCandidateAshbyWorkflow.mockRejectedValue(new MockApiError('nope', status));
    const { container } = renderCandidateCard();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('AshbyWorkflowCard — failures are sanitized, never silent absence', () => {
  it('shows a detail-free message on a server error', async () => {
    mockApi.getCandidateAshbyWorkflow.mockRejectedValue(new MockApiError('internal boom', 500));
    renderCandidateCard();
    const msg = await screen.findByText(/ashby screening status is unavailable right now/i);
    expect(msg).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/boom|stack|supabase|select/i);
  });

  it('does not crash the surrounding page when the API layer throws synchronously', async () => {
    mockApi.getCandidateAshbyWorkflow.mockImplementation(() => {
      throw new Error('client exploded');
    });
    renderCandidateCard();
    expect(
      await screen.findByText(/ashby screening status is unavailable right now/i),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('client exploded');
  });

  it('announces the loading state politely', async () => {
    mockApi.getCandidateAshbyWorkflow.mockReturnValue(new Promise(() => {}));
    renderCandidateCard();
    expect(await screen.findByText(/loading ashby screening status/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('AshbyWorkflowCard — accessible, colour-independent status', () => {
  it('labels every reported state in text', async () => {
    renderCandidateCard();
    await screen.findByText('Ashby screening pipeline');
    // Lifecycle: "awaiting delivery back to Ashby".
    expect(screen.getByText('Writing results back to Ashby')).toBeInTheDocument();
    // Ingestion: in progress.
    expect(screen.getByText('Scanning resume')).toBeInTheDocument();
    // Operations: pending + failed, each with its leg named in text.
    expect(screen.getByText('Screening invite')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Ashby scorecard')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    // Sanitized error code, shown verbatim.
    expect(screen.getByText('provider_5xx')).toBeInTheDocument();
    // The section is labelled by its heading and is a live region.
    expect(screen.getByRole('region', { name: 'Ashby screening pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders a real <time> element for the last update', async () => {
    renderCandidateCard();
    await screen.findByText('Ashby screening pipeline');
    const time = document.querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('dateTime', WORKFLOW.updatedAt);
  });

  it('introduces no button, link, or other control', async () => {
    renderCandidateCard();
    await screen.findByText('Ashby screening pipeline');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(document.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);
    expect(document.body.textContent).toMatch(/read-only status/i);
  });

  it('has no axe violations', async () => {
    const { container } = renderCandidateCard();
    await screen.findByText('Ashby screening pipeline');
    await expect(container).toHaveNoViolations();
  });

  it('shows a terminal state truthfully when one exists', () => {
    render(
      <AshbyWorkflowCardView
        workflow={{ ...WORKFLOW, terminalState: 'withdrawn', lifecycle: 'cancelled' }}
      />,
    );
    expect(screen.getByText('Application withdrawn')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('falls through to the raw value for an unknown state rather than inventing a label', () => {
    render(
      <AshbyWorkflowCardView
        workflow={{
          ...WORKFLOW,
          lifecycle: 'some_future_state',
          ingestionState: 'some_future_ingestion',
          operations: [{ type: 'invite_delivery', state: 'some_future_op', errorCode: null }],
        }}
      />,
    );
    expect(screen.getByText('some_future_state')).toBeInTheDocument();
    expect(screen.getByText('some_future_ingestion')).toBeInTheDocument();
    expect(screen.getByText('some_future_op')).toBeInTheDocument();
  });

  it('suppresses an error code that is not a sanitized stable code', () => {
    render(
      <AshbyWorkflowCardView
        workflow={{
          ...WORKFLOW,
          operations: [
            { type: 'scorecard_write', state: 'failed', errorCode: 'Provider said: <b>no</b>' },
          ],
        }}
      />,
    );
    expect(screen.queryByText(/Error code/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Provider said');
  });

  it('omits the timestamp line entirely when there is no usable timestamp', () => {
    render(<AshbyWorkflowCardView workflow={{ ...WORKFLOW, updatedAt: null }} />);
    expect(document.querySelector('time')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Updated/);
  });

  it('keeps one stable live region across loading and ready', async () => {
    let resolve!: (v: unknown) => void;
    mockApi.getCandidateAshbyWorkflow.mockReturnValue(new Promise((r) => (resolve = r)));
    renderCandidateCard();
    const region = await screen.findByRole('status');
    resolve({ ok: true, workflow: WORKFLOW });
    await screen.findByText('Writing results back to Ashby');
    // The SAME node, with swapped children — not a region inserted on arrival,
    // which screen readers announce inconsistently.
    expect(screen.getByRole('status')).toBe(region);
  });

  it('reports "Not started" rather than a blank when a leg has not begun', () => {
    render(
      <AshbyWorkflowCardView
        workflow={{ ...WORKFLOW, ingestionState: null, sessionStatus: null, operations: [] }}
      />,
    );
    expect(screen.getAllByText('Not started')).toHaveLength(2);
  });
});

describe('AshbyWorkflowCard — the two scopes are one surface', () => {
  it('reads through the link-scoped endpoint and renders the identical card', async () => {
    render(<AshbyWorkflowCard source={{ kind: 'applicationLink', applicationLinkId: LINK_ID }} />);
    await screen.findByText('Ashby screening pipeline');
    expect(mockApi.getAshbyScopedReviewWorkflow).toHaveBeenCalledWith(LINK_ID);
    expect(mockApi.getCandidateAshbyWorkflow).not.toHaveBeenCalled();
    expect(screen.getByText('Writing results back to Ashby')).toBeInTheDocument();
  });

  it('sends the link id and nothing else, and never the candidate endpoint', async () => {
    render(<AshbyWorkflowCard source={{ kind: 'applicationLink', applicationLinkId: LINK_ID }} />);
    await screen.findByText('Writing results back to Ashby');
    // Exactly one argument, exactly the link id — a candidate id could not be
    // smuggled in as a second argument either.
    expect(mockApi.getAshbyScopedReviewWorkflow.mock.calls).toEqual([[LINK_ID]]);
    expect(mockApi.getCandidateAshbyWorkflow).not.toHaveBeenCalled();
  });

  it('reads by candidate id only on the candidate-addressed surface', async () => {
    renderCandidateCard();
    await screen.findByText('Writing results back to Ashby');
    expect(mockApi.getCandidateAshbyWorkflow.mock.calls).toEqual([[CANDIDATE_ID]]);
    expect(mockApi.getAshbyScopedReviewWorkflow).not.toHaveBeenCalled();
  });
});
