/**
 * ScreeningPage accessibility tests.
 *
 * Covers:
 *   - Loading state
 *   - Transcript rendering with bot/candidate bubbles
 *   - Composer textarea and send button
 *   - Completed state with assessment
 *   - axe structural rule compliance
 *   - Keyboard interactions (Enter to send)
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScreeningPage } from './ScreeningPage';
import { mockAssessment, mockTranscript } from '../test/helpers';

// Mock scrollTo for jsdom
if (typeof Element !== 'undefined' && Element.prototype && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = vi.fn() as any;
}

const mockApi: Record<string, any> = {
  getSession: vi.fn(),
  turn: vi.fn(),
};

vi.mock('../api', () => ({
  api: {
    getSession: (...args: any[]) => mockApi.getSession(...args),
    turn: (...args: any[]) => mockApi.turn(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

function renderScreeningPage(sessionId = 'session-1') {
  return render(
    <MemoryRouter initialEntries={[`/screening/${sessionId}`]}>
      <Routes>
        <Route path="/screening/:sessionId" element={<ScreeningPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ScreeningPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockApi.getSession.mockReturnValue(new Promise(() => {}));
    renderScreeningPage();
    expect(screen.getByText('Loading session…')).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    mockApi.getSession.mockRejectedValue({ message: 'Session not found' });
    renderScreeningPage();
    expect(await screen.findByText('Session not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders header and back link', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'in_progress' },
      transcript: [],
      assessment: null,
    });
    renderScreeningPage();

    expect(await screen.findByText('Screening with Gopu')).toBeInTheDocument();
    expect(screen.getByText('← Back to candidates')).toBeInTheDocument();
  });

  it('renders empty transcript state', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'in_progress' },
      transcript: [],
      assessment: null,
    });
    renderScreeningPage();

    expect(
      await screen.findByText('Waiting for the conversation to begin…'),
    ).toBeInTheDocument();
  });

  it('renders transcript bubbles', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'in_progress' },
      transcript: mockTranscript,
      assessment: null,
    });
    renderScreeningPage();

    expect(await screen.findByText('Welcome to the screening.')).toBeInTheDocument();
    expect(screen.getByText('Thank you!')).toBeInTheDocument();
    expect(screen.getByText('Tell me about your experience.')).toBeInTheDocument();
  });

  it('shows composer with textarea and send button', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'in_progress' },
      transcript: [],
      assessment: null,
    });
    renderScreeningPage();

    expect(await screen.findByLabelText('Candidate answer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('send button is disabled when textarea is empty', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'in_progress' },
      transcript: [],
      assessment: null,
    });
    renderScreeningPage();

    const sendBtn = await screen.findByRole('button', { name: 'Send' });
    expect(sendBtn).toBeDisabled();
  });

  it('sends turn on Enter key', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'in_progress' },
      transcript: [],
      assessment: null,
    });
    mockApi.turn.mockResolvedValue({
      message: 'Interesting point! Tell me more.',
      done: false,
      assessment: null,
    });

    renderScreeningPage();
    const textarea = await screen.findByLabelText('Candidate answer');

    await userEvent.type(textarea, 'I have 5 years of experience in React.{Enter}');

    expect(
      await screen.findByText('Interesting point! Tell me more.'),
    ).toBeInTheDocument();
  });

  it('shows completed state and assessment when done', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'completed' },
      transcript: mockTranscript,
      assessment: mockAssessment,
    });
    renderScreeningPage();

    // 'Screening complete' appears twice: in subtitle and in composer area
    const completedTexts = await screen.findAllByText('Screening complete');
    expect(completedTexts.length).toBe(2);
    expect(screen.getByText('Assessment')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('has no axe violations in active state', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'in_progress' },
      transcript: mockTranscript,
      assessment: null,
    });
    const { container } = renderScreeningPage();
    await screen.findByText('Welcome to the screening.');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations in completed state', async () => {
    mockApi.getSession.mockResolvedValue({
      session: { id: 's1', status: 'completed' },
      transcript: mockTranscript,
      assessment: mockAssessment,
    });
    const { container } = renderScreeningPage();
    await screen.findAllByText('Screening complete');
    await expect(container).toHaveNoViolations();
  });
});
