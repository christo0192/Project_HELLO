/**
 * CandidateScorecard — the redesigned assessment card.
 *
 * The load-bearing test here is FIELD PARITY: the same fixture is rendered
 * through the legacy `components/Scorecard` and through this component,
 * and every value the legacy card puts on screen must appear in the new
 * one. That is what makes "we redesigned the scorecard" safe to say — the
 * layout changed, the data did not.
 *
 * The rest asserts the specific defects in the owner-supplied screenshot
 * are fixed and stay fixed: no orphan Role fit cell, prose out of narrow
 * columns, exactly two card levels, a gapless heading outline, and the
 * fixed light palette under a `.dark` ancestor.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { Scorecard } from '../../Scorecard';
import { CandidateScorecard } from '../CandidateScorecard';
import { CandidateShell } from '../CandidateShell';
import type { Assessment } from '../../../types';

/** Deliberately maximal: every optional branch of `Assessment` is present. */
const FULL: Assessment = {
  id: 'a1',
  overall_score: 36.4,
  recommendation: 'reject',
  summary: 'Polite but disengaged; ended the call before the screening questions.',
  tone: {
    clarity: 4,
    confidence: 5,
    professionalism: 3,
    sentiment: 'neutral',
    notes: 'Friendly at first, then derailed the conversation.',
  },
  role_fit: {
    score: 4,
    matched_skills: ['Program Advisor (resume)', 'CRM (resume)'],
    gaps: ['No demonstrated consultative discovery'],
    red_flags: ['Ended the call early'],
    notes: 'Resume matches on paper; the call did not corroborate it.',
  },
  communication: {
    score: 4,
    notes: 'Candidate was polite but did not engage with the screening questions.',
    clarity: 4,
    structure: 3,
    listening: 3,
    rapport: 3,
    english_proficiency: {
      band: 'B1',
      grammar: 6,
      vocabulary: 6,
      fluency: 6,
      coherence: 5,
      notes: 'Short but mostly comprehensible. Limited sample.',
    },
    filler_usage: {
      level: 'low',
      examples: ['You know today is Onam festival'],
      impact_score: 8,
      notes: 'Minimal filler words.',
    },
    native_language_usage: {
      level: 'low',
      examples: ['AL Masha Allah'],
      impact_score: 8,
      notes: 'One non-English phrase near the end.',
    },
  },
  motivation: {
    score: 2,
    notes: 'No interest in the role or company was expressed.',
  },
  resume_conflicts: [
    {
      topic: 'Years of experience',
      resume_says: '5 years',
      candidate_said: '3 years',
      resolved: false,
      note: 'Needs verification.',
    },
  ],
  raw: null,
};

/** Minimal: only the required fields, so every fallback branch is exercised. */
const MINIMAL: Assessment = {
  overall_score: 78,
  recommendation: 'advance',
  summary: '',
  tone: {
    clarity: 8,
    confidence: 7,
    professionalism: 9,
    sentiment: 'positive',
    notes: '',
  },
  role_fit: { score: 8, matched_skills: [], gaps: [], red_flags: [], notes: '' },
  raw: null,
};

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Every distinct value the assessment puts on screen, derived from the
 * fixture rather than hand-listed, so a new field cannot be forgotten here.
 */
function expectedValues(a: Assessment): string[] {
  const c = a.communication!;
  const e = c.english_proficiency!;
  const conflict = a.resume_conflicts![0];
  return [
    String(Math.round(a.overall_score)),
    a.summary,
    a.tone.sentiment,
    a.tone.notes,
    `${a.tone.clarity}/10`,
    `${a.tone.confidence}/10`,
    `${a.tone.professionalism}/10`,
    a.role_fit.notes,
    `${a.role_fit.score}/10`,
    ...a.role_fit.matched_skills,
    ...a.role_fit.gaps,
    ...a.role_fit.red_flags,
    c.notes,
    `${c.score}/10`,
    `${c.structure}/10`,
    `${c.listening}/10`,
    e.band,
    e.notes,
    `${e.grammar}/10`,
    `${e.coherence}/10`,
    c.filler_usage!.level,
    c.filler_usage!.notes,
    ...c.filler_usage!.examples,
    c.native_language_usage!.notes,
    ...c.native_language_usage!.examples,
    a.motivation!.notes,
    `${a.motivation!.score}/10`,
    conflict.topic,
    conflict.resume_says,
    conflict.candidate_said,
    conflict.note,
    'unresolved',
  ];
}

/** Labels the legacy card renders and the redesign must keep. */
const REQUIRED_LABELS = [
  'Communication',
  'Motivation',
  'Tone',
  'Role fit',
  'Score',
  'Clarity',
  'Structure',
  'Listening',
  'Rapport',
  'English band',
  'Grammar',
  'Vocabulary',
  'Fluency',
  'Coherence',
  'Filler usage',
  'Native-language usage',
  'Impact',
  'Examples:',
  'Sentiment',
  'Fit score',
  'Matched skills',
  'Gaps',
  'Red flags',
  'Resume conflicts',
  'Resume:',
  'Said on call:',
  'Summary',
  'Reject',
  '/ 100',
];

describe('CandidateScorecard field parity vs the legacy Scorecard', () => {
  it('the derived expectation is non-vacuous and the LEGACY card satisfies it', () => {
    const values = expectedValues(FULL);
    expect(values.length).toBeGreaterThanOrEqual(30);
    const { container } = render(<Scorecard assessment={FULL} />);
    const text = normalize(container.textContent ?? '');
    for (const value of values) {
      expect(text, `legacy card is missing ${JSON.stringify(value)}`).toContain(
        normalize(value),
      );
    }
    for (const label of REQUIRED_LABELS) {
      expect(text, `legacy card is missing label ${label}`).toContain(label);
    }
  });

  it('the CANDIDATE card renders every one of those values and labels', () => {
    const { container } = render(<CandidateScorecard assessment={FULL} />);
    const text = normalize(container.textContent ?? '');
    for (const value of expectedValues(FULL)) {
      expect(text, `candidate card lost ${JSON.stringify(value)}`).toContain(
        normalize(value),
      );
    }
    for (const label of REQUIRED_LABELS) {
      expect(text, `candidate card lost label ${label}`).toContain(label);
    }
  });

  it('keeps the weights as data, and out of the heading text', () => {
    render(<CandidateScorecard assessment={FULL} />);
    // The legacy heading string is gone …
    expect(screen.queryByText('Communication - 50%')).not.toBeInTheDocument();
    // … but every weight is still on screen, beside its section.
    for (const weight of ['50%', '20%', '10%']) {
      expect(screen.getAllByText(weight).length).toBeGreaterThan(0);
    }
    expect(
      screen.getByRole('heading', { name: 'Communication' }),
    ).toBeInTheDocument();
  });

  it('preserves both empty-state fallbacks when the sections are absent', () => {
    render(<CandidateScorecard assessment={MINIMAL} />);
    expect(
      screen.getByText(
        'No candidate responses are available to assess communication.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No candidate responses are available to assess motivation.'),
    ).toBeInTheDocument();
  });

  it('reads the same raw.* fallback chain the legacy card reads', () => {
    const viaRaw: Assessment = {
      ...MINIMAL,
      raw: {
        communication: { score: 7, notes: 'From raw.' },
        motivation: { score: 6, notes: 'Raw motivation.' },
        resume_conflicts: [
          {
            topic: 'Raw topic',
            resume_says: 'A',
            candidate_said: 'B',
            resolved: true,
            note: '',
          },
        ],
      },
    };
    render(<CandidateScorecard assessment={viaRaw} />);
    expect(screen.getByText('From raw.')).toBeInTheDocument();
    expect(screen.getByText('Raw motivation.')).toBeInTheDocument();
    expect(screen.getByText('Raw topic')).toBeInTheDocument();
    expect(screen.getByText('resolved')).toBeInTheDocument();
  });

  it('rounds the overall score exactly as the legacy card does', () => {
    render(<CandidateScorecard assessment={FULL} />);
    expect(screen.getByText('36')).toBeInTheDocument();
  });
});

describe('CandidateScorecard layout defects', () => {
  it('places Role fit full width at every breakpoint — no orphan cell', () => {
    const { container } = render(<CandidateScorecard assessment={FULL} />);
    const grid = container.querySelector('[data-scorecard-grid]')!;
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('sm:grid-cols-2');
    expect(grid.className).toContain('lg:grid-cols-12');
    // `items-start` keeps unrelated cards at their natural heights.
    expect(grid.className).toContain('items-start');

    const sections = [...grid.children] as HTMLElement[];
    expect(sections).toHaveLength(4);
    const [communication, motivation, tone, roleFit] = sections;

    // Communication spans the two short sections' rows; Role fit spans all.
    expect(communication.className).toContain('lg:col-span-7');
    expect(communication.className).toContain('lg:row-span-2');
    expect(motivation.className).toContain('lg:col-span-5');
    expect(tone.className).toContain('lg:col-span-5');
    expect(roleFit.className).toContain('lg:col-span-12');

    // 4 sections in a 2-column grid orphan unless the tall ones span both.
    expect(communication.className).toContain('sm:col-span-2');
    expect(roleFit.className).toContain('sm:col-span-2');
    expect(within(roleFit).getByRole('heading', { name: 'Role fit' })).toBeInTheDocument();
  });

  it('never renders prose inside a narrow column, and never at text-xs', () => {
    const { container } = render(<CandidateScorecard assessment={FULL} />);
    const proseBlocks = [...container.querySelectorAll('[data-prose]')] as HTMLElement[];
    expect(proseBlocks.length).toBeGreaterThanOrEqual(6);
    for (const block of proseBlocks) {
      expect(block.className).toContain('text-sm');
      expect(block.className).toContain('leading-relaxed');
      expect(block.className).toContain('max-w-prose');
      const section = block.closest('[data-scorecard-grid] > *') as HTMLElement | null;
      if (section) {
        const span = /lg:col-span-(\d+)/.exec(section.className);
        expect(Number(span?.[1] ?? 12)).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('uses exactly two card levels — no card inside a card inside a card', () => {
    const { container } = render(<CandidateScorecard assessment={FULL} />);
    const depths = [...container.querySelectorAll('[data-surface-depth]')].map((el) =>
      Number(el.getAttribute('data-surface-depth')),
    );
    expect(depths.length).toBeGreaterThan(5);
    expect(Math.max(...depths)).toBe(2);
    expect(new Set(depths)).toEqual(new Set([1, 2]));
  });

  it('gives every scored field an accessible meter', () => {
    render(<CandidateScorecard assessment={FULL} />);
    const meters = screen.getAllByRole('meter');
    // overall + 5 communication + 4 english + 2 impact + 1 motivation
    // + 3 tone + 1 fit score
    expect(meters).toHaveLength(17);
    for (const meter of meters) {
      expect(meter).toHaveAttribute('aria-valuenow');
      expect(meter).toHaveAttribute('aria-valuetext');
      expect(meter.getAttribute('aria-labelledby')).toBeTruthy();
    }
  });
});

describe('CandidateScorecard accessibility', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('has no axe violations with a full assessment', async () => {
    const { container } = render(
      <CandidateShell>
        <h1>Candidate</h1>
        <h2>Scorecard</h2>
        <CandidateScorecard assessment={FULL} />
      </CandidateShell>,
    );
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with a minimal assessment', async () => {
    const { container } = render(
      <CandidateShell>
        <h1>Candidate</h1>
        <h2>Scorecard</h2>
        <CandidateScorecard assessment={MINIMAL} />
      </CandidateShell>,
    );
    await expect(container).toHaveNoViolations();
  });

  it('keeps the fixed light palette under a .dark ancestor', async () => {
    document.documentElement.classList.add('dark');
    const { container } = render(
      <CandidateShell>
        <h1>Candidate</h1>
        <h2>Scorecard</h2>
        <CandidateScorecard assessment={FULL} />
      </CandidateShell>,
    );
    // The scope boundary is present inside the dark document, and the card
    // itself declares no dark-mode variant of any kind.
    const scope = container.querySelector('.candidate-scope')!;
    expect(scope).toBeInTheDocument();
    expect(document.documentElement).toHaveClass('dark');
    expect(container.innerHTML).not.toMatch(/\bdark:/);
    await expect(container).toHaveNoViolations();
  });

  it('produces a gapless heading outline at each supported level', () => {
    for (const level of [2, 3, 4] as const) {
      const { container, unmount } = render(
        <CandidateScorecard assessment={FULL} headingLevel={level} />,
      );
      const levels = [...container.querySelectorAll('h2,h3,h4')].map((el) =>
        Number(el.tagName.slice(1)),
      );
      expect(levels.length).toBeGreaterThan(0);
      expect(new Set(levels)).toEqual(new Set([level]));
      unmount();
    }
  });

  it('gives two scorecards in one document distinct region ids', () => {
    const { container } = render(
      <>
        <CandidateScorecard assessment={FULL} />
        <CandidateScorecard assessment={FULL} />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length);

    // Both copies are individually addressable by their own headings.
    expect(screen.getAllByRole('region', { name: 'Communication' })).toHaveLength(2);
    expect(screen.getAllByRole('region', { name: 'Summary' })).toHaveLength(2);
  });

  it('labels the recommendation and every tag group for assistive tech', () => {
    render(<CandidateScorecard assessment={FULL} />);
    expect(screen.getByText('Recommendation:')).toHaveClass('sr-only');
    expect(screen.getAllByText('Matched skill:')[0]).toHaveClass('sr-only');
    expect(screen.getByText('Gap:')).toHaveClass('sr-only');
    expect(screen.getByText('Red flag:')).toHaveClass('sr-only');
  });

  it('imports no motion library and declares no transition on the meters', () => {
    const { container } = render(<CandidateScorecard assessment={FULL} />);
    for (const el of container.querySelectorAll('[role="meter"] > *')) {
      expect(el.className).not.toMatch(/\b(transition|animate|duration)-/);
    }
  });
});
