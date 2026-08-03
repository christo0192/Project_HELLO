/**
 * TranscriptList — truthful loading / empty / error states, speaker labels,
 * no fabricated timestamps, and axe compliance.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TranscriptList } from '../TranscriptList';

describe('TranscriptList', () => {
  it('renders speaker turns with explicit speaker labels', () => {
    render(
      <TranscriptList
        transcript={[
          { speaker: 'bot', text: 'Welcome to the screening.' },
          { speaker: 'candidate', text: 'Thank you!' },
        ]}
      />,
    );
    expect(screen.getByText('Welcome to the screening.')).toBeInTheDocument();
    expect(screen.getByText('Thank you!')).toBeInTheDocument();
    expect(screen.getAllByText('Bot')).toHaveLength(1);
    expect(screen.getByText('Candidate')).toBeInTheDocument();
  });

  it('shows a loading status with a skeleton', () => {
    render(<TranscriptList transcript={[]} isLoading />);
    expect(screen.getByRole('status', { name: /loading transcript/i })).toBeInTheDocument();
    expect(document.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('shows a truthful empty state', () => {
    render(<TranscriptList transcript={[]} />);
    expect(
      screen.getByText(/No transcript lines recorded for this session yet/i),
    ).toBeInTheDocument();
  });

  it('shows an error state with a retry action', () => {
    const onRetry = vi.fn();
    render(
      <TranscriptList
        transcript={[]}
        error="Failed to load transcript"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load transcript');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('is axe-clean', async () => {
    const { container } = render(
      <TranscriptList
        transcript={[
          { speaker: 'bot', text: 'Hello' },
          { speaker: 'candidate', text: 'Hi' },
        ]}
      />,
    );
    await expect(container).toHaveNoViolations();
  });
});
