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
import { CandidateProfileCard, NotesList, SessionsSummary } from '../CandidateOverviewSections';
import { mockCandidate, mockSession } from '../../../test/helpers';
import type { CandidateDetail, Note, Session } from '../../../types';

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

describe('SessionsSummary and R1', () => {
  const session = (id: string, created_at: string, interview_round_id: string | null) =>
    ({ ...sessionsOf(1)[0], id, created_at, interview_round_id, mode: interview_round_id ? 'browser' : 'live' });

  it('takes an R1 session straight to its recording on the review page, for every role', () => {
    render(
      <MemoryRouter>
        <SessionsSummary
          sessions={[
            session('r1-b', '2026-08-03T00:00:00.000Z', 'round-1'),
            session('r1-a', '2026-08-02T00:00:00.000Z', 'round-1'),
            session('phone', '2026-08-01T00:00:00.000Z', null),
          ]}
        />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole('link', { name: /View details/ }).map((link) => link.getAttribute('href'));
    expect(links).toEqual([
      '/interviews/round-1?attempt=2&tab=recording',
      '/interviews/round-1?attempt=1&tab=recording',
      '/sessions/phone',
    ]);
  });

  it('names an R1 session as what it is', () => {
    render(
      <MemoryRouter>
        <SessionsSummary sessions={[session('r1-a', '2026-08-02T00:00:00.000Z', 'round-1')]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('R1 role-play')).toBeInTheDocument();
  });
});

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

/**
 * M017: a phone-parsing candidate has no resume, so the Profile card must not
 * claim its facts were "parsed from the resume", and an empty Skills list is
 * "No resume" rather than a parse that found nothing.
 */
describe('CandidateProfileCard intake wording', () => {
  const candidate = (patch: Partial<CandidateDetail['candidate']>) =>
    ({
      ...mockCandidate,
      name: 'Test Person',
      skills: [],
      experience_years: null,
      parsed: null,
      ...patch,
    }) as CandidateDetail['candidate'];

  it('names the Ashby application as the source for phone parsing', () => {
    render(<CandidateProfileCard candidate={candidate({ intake_type: 'phone_parsing' })} />);
    expect(
      screen.getByText('Name and phone from the Ashby application (no usable resume).'),
    ).toBeInTheDocument();
    expect(screen.getByText('No resume')).toBeInTheDocument();
    expect(screen.queryByText('Identity and skills as parsed from the resume.')).toBeNull();
    expect(screen.queryByText('None parsed')).toBeNull();
  });

  it.each([
    ['resume parsing', { intake_type: 'resume_parsing' as const }],
    ['a null intake', { intake_type: null }],
    ['an older API (no field)', {}],
  ])('keeps the resume wording for %s', (_label, patch) => {
    render(<CandidateProfileCard candidate={candidate(patch)} />);
    expect(screen.getByText('Identity and skills as parsed from the resume.')).toBeInTheDocument();
    expect(screen.getByText('None parsed')).toBeInTheDocument();
    expect(screen.queryByText('No resume')).toBeNull();
  });
});

describe('CandidateProfileCard phone number', () => {
  const withPhone = (phone_valid: boolean) =>
    ({
      ...mockCandidate,
      name: 'Test Person',
      skills: [],
      experience_years: null,
      parsed: null,
      phone_e164: '+919876543210',
      phone_valid,
    }) as CandidateDetail['candidate'];

  it('marks an invalid number unresolved, as "Wrong number" is: nobody on our side failed', () => {
    render(<CandidateProfileCard candidate={withPhone(false)} />);
    const chip = screen.getByText('Invalid');
    expect(chip).toHaveClass('bg-unresolved-soft', 'text-unresolved-text', 'ring-unresolved');
    expect(chip.className).not.toContain('--c-negative');
  });

  it('adds no chip to a valid number', () => {
    render(<CandidateProfileCard candidate={withPhone(true)} />);
    expect(screen.queryByText('Invalid')).toBeNull();
  });
});
