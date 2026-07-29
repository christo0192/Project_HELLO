/**
 * LiveKitCallCard accessibility tests.
 *
 * Covers:
 *   - Idle state (default, no call active)
 *   - Button label and state
 *   - Candidate name rendering
 *   - axe structural rule compliance
 *
 * Note: This component requires LiveKit and AudioContext for its active
 * states. Only the idle (pre-call) state is tested here, which renders
 * reliably without media or network. Full LiveKit integration testing
 * requires a real browser environment.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiveKitCallCard } from './LiveKitCallCard';

// Mock api to prevent network calls
vi.mock('../api', () => ({
  api: {
    startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

describe('LiveKitCallCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders heading', () => {
    render(
      <LiveKitCallCard candidateId="candidate-1" candidateName="Jane Doe" />,
    );
    expect(screen.getByText('LiveKit voice screening')).toBeInTheDocument();
  });

  it('shows candidate name in description', () => {
    render(
      <LiveKitCallCard candidateId="candidate-1" candidateName="Jane Doe" />,
    );
    expect(
      screen.getByText(
        /Starts a LiveKit room for Jane Doe/,
      ),
    ).toBeInTheDocument();
  });

  it('renders "Start Screening" button in idle state', () => {
    render(
      <LiveKitCallCard candidateId="candidate-1" candidateName="Jane Doe" />,
    );
    const btn = screen.getByRole('button', { name: 'Start Screening' });
    expect(btn).toBeInTheDocument();
  });

  it('has no axe violations in idle state', async () => {
    const { container } = render(
      <LiveKitCallCard candidateId="candidate-1" candidateName="Jane Doe" />,
    );
    await expect(container).toHaveNoViolations();
  });
});
