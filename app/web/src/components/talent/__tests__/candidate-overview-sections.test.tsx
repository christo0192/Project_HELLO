/**
 * The Overview reference rail bounds its own lists.
 *
 * Sessions and notes moved into a STICKY left rail, so an unbounded list
 * would grow its card past the viewport and take the rail's stickiness with
 * it. Past the thresholds the rows scroll inside a focusable, labelled
 * region instead — and the region's name deliberately differs from the card
 * that contains it, because two `region` landmarks sharing a role and an
 * accessible name is an axe `landmark-unique` violation.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { NotesList, SessionsSummary } from '../CandidateOverviewSections';
import { mockSession } from '../../../test/helpers';
import type { Note, Session } from '../../../types';

function sessionsOf(count: number): Session[] {
  return Array.from({ length: count }, (_, i) => ({
    ...mockSession,
    id: `session-${i + 1}`.padEnd(10, '0'),
  })) as Session[];
}

function notesOf(count: number): Note[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i + 1}`,
    candidate_id: 'candidate-1',
    author_id: 'u1',
    note: `note ${i + 1}`,
    created_at: '2026-01-01T00:00:00Z',
  })) as Note[];
}

function renderSessions(count: number) {
  return render(
    <MemoryRouter>
      <SessionsSummary sessions={sessionsOf(count)} />
    </MemoryRouter>,
  );
}

describe('SessionsSummary bounding', () => {
  it('lists five sessions inline, with no nested scroll region', () => {
    renderSessions(5);
    expect(screen.getByRole('region', { name: 'Screening sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Screening session list' })).toBeNull();
    expect(screen.getAllByText(/^Session /)).toHaveLength(5);
  });

  it('scrolls a sixth session inside a focusable, separately named region', () => {
    renderSessions(6);
    const region = screen.getByRole('region', { name: 'Screening session list' });
    expect(region).toHaveAttribute('tabindex', '0');
    // Every row is still rendered — bounded, not truncated.
    expect(screen.getAllByText(/^Session /)).toHaveLength(6);
  });
});

describe('NotesList bounding', () => {
  it('lists four notes inline', () => {
    render(<NotesList notes={notesOf(4)} />);
    expect(screen.queryByRole('region', { name: 'Note history' })).toBeNull();
    expect(screen.getByText('note 4')).toBeInTheDocument();
  });

  it('scrolls a fifth note inside a focusable region', () => {
    render(<NotesList notes={notesOf(5)} />);
    const region = screen.getByRole('region', { name: 'Note history' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('note 5')).toBeInTheDocument();
  });
});
