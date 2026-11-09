/**
 * The rating summary in the candidate page header: what it prints, and above all when it prints
 * nothing. Its figures can never come from anywhere but the scorecard the reasoning pane is showing, so
 * these drive the real workspace and read the slot the page would give it. The fit in the row needs a
 * real browser: e2e/review.e2e.ts.
 */
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within, configure } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

configure({ asyncUtilTimeout: 3000 });
import { CandidateHeader, ratingsFit } from '../CandidateShell';
import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';
import { mockAssessment } from '../../../test/helpers';
import type { Assessment, Session, TranscriptLine } from '../../../types';

const mockApi = { getSession: vi.fn(), getCandidatePhoneAttempts: vi.fn(), listR1Rounds: vi.fn() };
const mockRecordingApi = { getRecordingDownloadUrl: vi.fn(), getAttemptRecordingDownloadUrl: vi.fn() };

vi.mock('../../../api', () => ({
  api: {
    getSession: (...args: unknown[]) => mockApi.getSession(...args),
    getRecordingDownloadUrl: (...args: unknown[]) => mockRecordingApi.getRecordingDownloadUrl(...args),
    getAttemptRecordingDownloadUrl: (...args: unknown[]) => mockRecordingApi.getAttemptRecordingDownloadUrl(...args),
    getCandidatePhoneAttempts: (...args: unknown[]) => mockApi.getCandidatePhoneAttempts(...args),
    listR1Rounds: (...args: unknown[]) => mockApi.listR1Rounds(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const SESSION: Session = {
  id: 'session-1',
  candidate_id: 'c1',
  role_id: null,
  status: 'completed',
  mode: 'live',
  created_at: '2026-10-05T03:30:00.000Z',
  recording_egress_started_at_ms: Date.parse('2026-10-05T03:30:00.000Z'),
};
const OLDER: Session = { ...SESSION, id: 'session-0', created_at: '2026-09-05T03:30:00.000Z' };

const TRANSCRIPT: TranscriptLine[] = [
  { speaker: 'bot', text: 'What is your monthly target?', start_offset_sec: 5 },
  { speaker: 'candidate', text: 'My target is twelve a month and I usually reach it.', start_offset_sec: 10 },
  { speaker: 'bot', text: 'What do you say when the fee feels too high?', start_offset_sec: 20 },
  { speaker: 'candidate', text: 'I tell them about the EMI option first.', start_offset_sec: 26 },
];

function metricResult(id: string, name: string, weightBps: number, score: number | null, evidenceRefs: string[] = [], rationale: string | null = `${name} rationale.`) {
  return {
    configMetricId: id,
    score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale,
    evidenceRefs,
    metric: { id, name, weightBps },
  };
}

const SIX = [
  metricResult('m-comm', 'Communication', 6000, 2, ['the EMI option first']),
  metricResult('m-comp', 'Compensation fit', 1000, null),
  metricResult('m-prof', 'Profile relevance', 1000, 3, ['My target is twelve a month']),
  metricResult('m-stab', 'Stability', 1000, 1),
  metricResult('m-shift', 'Shift fitment', 500, 4),
  metricResult('m-wfo', 'Work from office fitment', 500, 3),
];

function assessment(over: Record<string, unknown> = {}, rawOver: Record<string, unknown> = {}): Assessment {
  return {
    id: 'a1',
    session_id: 'session-1',
    schema_version: 2,
    scoring_status: 'incomplete_evidence',
    overall_score: 43,
    recommendation: 'reject',
    summary: '',
    role_fit: { score: 0, matched_skills: [], gaps: [], red_flags: [], notes: '' },
    raw: {
      schemaVersion: 2,
      status: 'incomplete_evidence',
      scoreScaleMax: 4,
      metricResults: SIX,
      weightedScore5: 2,
      overallScore: 43,
      recommendation: 'reject',
      ...rawOver,
    },
    ...over,
  } as unknown as Assessment;
}

/** A legacy (v1) row: the 0-10 bars, with no per-metric results to summarise. */
const legacy = () => ({ ...mockAssessment, session_id: 'session-1', schema_version: 1 }) as unknown as Assessment;

const firm = (over: Record<string, unknown> = {}, rawOver: Record<string, unknown> = {}) =>
  assessment({ scoring_status: 'complete', ...over }, { status: 'complete', ...rawOver });

/** The page's half of the contract: a place in its header, handed to the workspace once it exists. */
function Host(props: Partial<React.ComponentProps<typeof TranscriptionSyncWorkspace>>) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      <div ref={setSlot} data-testid="slot" />
      <TranscriptionSyncWorkspace
        sessions={[SESSION]}
        assessments={[]}
        blocked={false}
        candidateId="c1"
        candidateName="Asha Rao"
        roleTitle="Sales Advisor"
        ratingsSlot={slot}
        {...props}
      />
    </>
  );
}

function renderHost({ card = assessment(), ...props }: Partial<React.ComponentProps<typeof TranscriptionSyncWorkspace>> & { card?: Assessment | null } = {}) {
  mockApi.getSession.mockResolvedValue({ session: SESSION, transcript: TRANSCRIPT, assessment: card });
  return render(<Host assessments={card ? [card] : []} {...props} />);
}

const slot = () => screen.getByTestId('slot');
const reasoning = () => document.querySelector<HTMLElement>('[data-review-pane="reasoning"]')!;
const settled = () => screen.findByText('What is your monthly target?');
const item = (name: RegExp) => within(slot()).getByRole('button', { name });
const items = () => within(slot()).queryAllByRole('button');
const row = (id: string) => reasoning().querySelector<HTMLElement>(`[data-rubric-row="${id}"]`)!;
const reserve = () => slot().querySelector('[data-header-ratings-reserve]');

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { __allowConsole?: (pattern: RegExp) => void }).__allowConsole?.(/inside a test was not wrapped in act/);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [], next_cursor: null });
  mockApi.listR1Rounds.mockResolvedValue({ rounds: [] });
  mockRecordingApi.getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/leg' });
  mockRecordingApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/session' });
});

describe('what it prints', () => {
  it('one item per metric, in rubric order, as the rubric names them', async () => {
    renderHost();
    await settled();
    expect(items().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Communication, Average, 2 of 4',
      'Compensation fit, Insufficient evidence',
      'Profile relevance, Good, 3 of 4',
      'Stability, Poor, 1 of 4',
      'Shift fitment, Excellent, 4 of 4',
      'Work from office fitment, Good, 3 of 4',
    ]);
  });

  it('gives the full name, the rating word and the figure in the title, for a name the row cuts short', async () => {
    renderHost();
    await settled();
    const long = item(/^Work from office fitment/);
    expect(long).toHaveAttribute('title', 'Work from office fitment, Good, 3 of 4');
    expect(long).toHaveTextContent('Work from office fitment');
    // The rating word stays out of the row: it does not fit.
    expect(long).not.toHaveTextContent('Good');
    expect(within(long).getByText('3/4')).toBeInTheDocument();
    expect(within(long).getByText('Work from office fitment')).toHaveClass('truncate');
  });

  it.each([
    [/^Shift fitment/, 'ready', 4],
    [/^Profile relevance/, 'ready', 3],
    [/^Communication/, 'unresolved', 2],
    [/^Stability/, 'closed', 1],
  ])('prints %s in the %s family, with %i of its pips filled', async (name, family, filled) => {
    renderHost();
    await settled();
    const button = item(name);
    const pips = button.querySelector<HTMLElement>('[data-rating-pips]')!;
    const marks = [...pips.children];
    expect(marks).toHaveLength(4);
    expect(marks.filter((mark) => mark.classList.contains('data-fill'))).toHaveLength(filled);
    for (const mark of marks.slice(0, filled)) expect(mark).toHaveClass(`bg-${family}`, `border-${family}`);
    expect(within(button).getByText(`${filled}/4`).parentElement).toHaveClass(`text-${family}-text`);
    // The same pips as the rubric row beside its rationale, so the two cannot disagree.
    const inRow = [...row(button.getAttribute('data-header-rating')!).querySelector('[data-rating-pips]')!.children];
    expect(marks.map((mark) => mark.className)).toEqual(inRow.map((mark) => mark.className));
  });

  it('reads a 5-point row on its own scale', async () => {
    renderHost({
      card: firm({}, { scoreScaleMax: 5, metricResults: [metricResult('m-a', 'Rapport', 5000, 4), metricResult('m-b', 'Closing', 5000, 3)] }),
    });
    await settled();
    const rapport = item(/^Rapport/);
    expect(rapport).toHaveAttribute('aria-label', 'Rapport, Good, 4 of 5');
    expect(rapport.querySelector('[data-rating-pips]')!.children).toHaveLength(5);
    expect(within(rapport).getByText('4/5').parentElement).toHaveClass('text-ready-text');
    expect(within(item(/^Closing/)).getByText('3/5').parentElement).toHaveClass('text-unresolved-text');
  });

  it('prints a metric with no score as a dashed mark and a dash, never as a rating', async () => {
    renderHost();
    await settled();
    const unscored = item(/^Compensation fit/);
    expect(unscored.querySelector('[data-rating-pips]')).toBeNull();
    const mark = unscored.querySelector<HTMLElement>('[data-rating-none]')!;
    expect(mark).toHaveClass('border-dashed', 'border-unresolved');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(unscored).toHaveTextContent('Compensation fit—');
  });

  it('leads with the Provisional words whenever the verdict box carries them, and their count is the box\'s', async () => {
    renderHost();
    await settled();
    expect(reasoning().querySelector('[data-verdict-box]')).toHaveTextContent('Provisional · 5 of 6 metrics');
    const lead = slot().querySelector<HTMLElement>('[data-header-ratings-lead]')!;
    expect(lead).toHaveTextContent('Provisional · 5 of 6 metrics');
    expect(within(lead).getByText('Provisional')).toHaveClass('text-unresolved-text', 'font-semibold');
    // First in the reading order too.
    expect(lead.compareDocumentPosition(items()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names the items with those words, so a keyboard reader hears them on the way in', async () => {
    renderHost();
    await settled();
    const group = within(slot()).getByRole('group', { name: 'Provisional · 5 of 6 metrics' });
    expect(within(group).getByRole('list', { name: 'Rubric' })).toBeInTheDocument();
    for (const button of items()) expect(group).toContainElement(button);
  });

  it('has no Provisional words over a firm scorecard, as its verdict box has none', async () => {
    renderHost({ card: firm() });
    await settled();
    expect(reasoning().querySelector('[data-verdict-box]')).not.toHaveTextContent('Provisional');
    expect(items()).toHaveLength(6);
    expect(slot()).not.toHaveTextContent('Provisional');
    // No words to name it with, so no group to announce.
    expect(within(slot()).queryByRole('group')).toBeNull();
  });

  it('has no hue on a scorecard held for thin evidence, as the rubric rows have none', async () => {
    renderHost({ card: assessment({ evidence_grade: 'insufficient', evidence_reason: 'partial_thin' }) });
    await settled();
    const button = item(/^Shift fitment/);
    expect(button.querySelector('[data-rating-pips] > .data-fill')).toHaveClass('bg-ink');
    expect(within(button).getByText('4/4').parentElement).toHaveClass('text-ink');
  });

  it('prints a row with no verdict, which the box reads as "Needs human review" with its figure and ratings', async () => {
    renderHost({ card: assessment({ recommendation: null }, { recommendation: null }) });
    await settled();
    expect(reasoning().querySelector('[data-verdict-box]')).toHaveTextContent('Needs human review');
    expect(reasoning().querySelector('[data-verdict-box]')).toHaveTextContent('43');
    expect(items()).toHaveLength(6);
  });

  it('names a metric with no human name as the rubric does, never by its opaque id', async () => {
    renderHost({ card: firm({}, { metricResults: [metricResult('m-a', 'm-a', 10000, 3)] }) });
    await settled();
    expect(item(/^Metric 1/)).toHaveAttribute('aria-label', 'Metric 1, Good, 3 of 4');
    expect(slot()).not.toHaveTextContent('m-a');
  });
});

describe('what it never prints', () => {
  const empty = async () => {
    await settled();
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalled());
    expect(slot()).toBeEmptyDOMElement();
  };

  it('while decision use is blocked', async () => {
    renderHost({ blocked: true });
    await empty();
    expect(screen.getByText('Scorecards are suppressed while an appeal is under review.')).toBeInTheDocument();
  });

  it('for R1 alone: that session is not in this workspace, so nothing is read and nothing prints', () => {
    renderHost({ sessions: [{ ...SESSION, interview_round_id: 'round-1' }] });
    expect(mockApi.getSession).not.toHaveBeenCalled();
    expect(slot()).toBeEmptyDOMElement();
    expect(document.querySelector('[data-header-rating]')).toBeNull();
  });

  it('from an R1 row: beside one, the phone scorecard alone', async () => {
    const r1Row = firm({ id: 'a-r1', session_id: 'session-r1' }, { metricResults: [metricResult('m-r1', 'Role play', 10000, 4)] });
    mockApi.getSession.mockResolvedValue({ session: SESSION, transcript: TRANSCRIPT, assessment: assessment() });
    render(<Host sessions={[{ ...SESSION, id: 'session-r1', interview_round_id: 'round-1' }, SESSION]} assessments={[r1Row, assessment()]} />);
    await settled();
    expect(mockApi.getSession).toHaveBeenCalledWith('session-1');
    expect(items()).toHaveLength(6);
    expect(slot()).not.toHaveTextContent('Role play');
  });

  it('on a legacy row', async () => {
    renderHost({ card: legacy() });
    await empty();
    expect(screen.getByRole('heading', { name: 'Scorecard for this session' })).toBeInTheDocument();
  });

  it('with no scorecard', async () => {
    renderHost({ card: null });
    await empty();
  });

  it('with no metric scored, though the row is v2 and the rubric still lists them', async () => {
    renderHost({
      card: assessment({ overall_score: null, recommendation: null }, {
        overallScore: null,
        recommendation: null,
        metricResults: [metricResult('m-a', 'Rapport', 5000, null), metricResult('m-b', 'Closing', 5000, null)],
      }),
    });
    await empty();
    expect(screen.getAllByText('Not scored').length).toBeGreaterThan(0);
  });

  it('when the verdict box has no figure, whatever a metric carries', async () => {
    renderHost({ card: assessment({ overall_score: null, recommendation: null }, { overallScore: null, recommendation: null }) });
    await empty();
  });

  it('with no metrics at all', async () => {
    renderHost({ card: firm({}, { metricResults: [] }) });
    await empty();
    expect(screen.getByText('This assessment carries no per-metric results.')).toBeInTheDocument();
  });

  it('on another tab: Profile has HeaderScore, and the R1 tab its own result', async () => {
    renderHost({ active: false });
    await empty();
  });

  it('with no place to print it: the scoped Ashby page offers none', async () => {
    mockApi.getSession.mockResolvedValue({ session: SESSION, transcript: TRANSCRIPT, assessment: assessment() });
    render(<TranscriptionSyncWorkspace sessions={[SESSION]} assessments={[]} blocked={false} candidateId="c1" />);
    await settled();
    expect(document.querySelector('[data-header-rating]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Communication' })).toBeInTheDocument();
  });

  describe('another call\'s figures', () => {
    const denied = () => mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));

    it('never, when the panel shows "Latest scorecard" for another call', async () => {
      denied();
      const newer: Session = { ...SESSION, id: 'session-2', created_at: '2026-10-07T03:30:00.000Z' };
      render(<Host sessions={[SESSION, newer]} assessments={[assessment({ session_id: 'session-2' })]} />);
      expect(await screen.findByRole('heading', { name: 'Latest scorecard' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Communication' })).toBeInTheDocument();
      expect(slot()).toBeEmptyDOMElement();
    });

    it('the selected call\'s own row still prints, under the same denied read', async () => {
      denied();
      render(<Host assessments={[assessment()]} />);
      expect(await screen.findByRole('heading', { name: 'AI recommendation' })).toBeInTheDocument();
      expect(items()).toHaveLength(6);
    });

    it('nor when a read failed and only another call\'s row is to hand', async () => {
      mockApi.getSession.mockRejectedValue(new Error('down'));
      render(<Host assessments={[assessment({ session_id: 'session-2' })]} />);
      expect(await screen.findByText('The transcript could not be loaded.')).toBeInTheDocument();
      expect(slot()).toBeEmptyDOMElement();
    });

    it('a failed read keeps the selected call\'s own row, as the panel does', async () => {
      mockApi.getSession.mockRejectedValue(new Error('down'));
      render(<Host assessments={[assessment()]} />);
      expect(await screen.findByText('The transcript could not be loaded.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'AI recommendation' })).toBeInTheDocument();
      expect(items()).toHaveLength(6);
    });
  });
});

describe('following the session picker', () => {
  const OTHER = [metricResult('m-a', 'Rapport', 5000, 4), metricResult('m-b', 'Closing', 5000, 1)];
  const older = () => firm({ id: 'a0', session_id: 'session-0' }, { metricResults: OTHER });

  function pickOlder() {
    fireEvent.click(screen.getByRole('button', { name: /^Screening/ }));
    fireEvent.click(screen.getByRole('option', { name: /5 Sept 2026|5 Sep 2026/ }));
  }

  it('shows the picked session\'s figures, and the last one\'s are gone at once', async () => {
    mockApi.getSession.mockResolvedValueOnce({ session: SESSION, transcript: TRANSCRIPT, assessment: assessment() });
    render(<Host sessions={[SESSION, OLDER]} assessments={[assessment(), older()]} />);
    await settled();
    expect(item(/^Communication/)).toBeInTheDocument();

    let answer: (detail: unknown) => void = () => undefined;
    mockApi.getSession.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    pickOlder();
    expect(mockApi.getSession).toHaveBeenLastCalledWith('session-0');
    // The panel has no scorecard yet, so neither does the header.
    expect(items()).toHaveLength(0);
    expect(slot()).not.toHaveTextContent('Communication');

    answer({ session: OLDER, transcript: TRANSCRIPT, assessment: older() });
    expect(await within(slot()).findByRole('button', { name: /^Rapport/ })).toHaveAttribute('aria-label', 'Rapport, Excellent, 4 of 4');
    expect(items()).toHaveLength(2);
  });

  it('prints nothing for a picked session with no scorecard, with no box left behind', async () => {
    mockApi.getSession.mockResolvedValueOnce({ session: SESSION, transcript: TRANSCRIPT, assessment: assessment() });
    render(<Host sessions={[SESSION, OLDER]} assessments={[assessment()]} />);
    await settled();
    expect(items()).toHaveLength(6);
    mockApi.getSession.mockResolvedValueOnce({ session: OLDER, transcript: TRANSCRIPT, assessment: null });
    pickOlder();
    await waitFor(() => expect(mockApi.getSession).toHaveBeenLastCalledWith('session-0'));
    await waitFor(() => expect(slot()).toBeEmptyDOMElement());
  });

  it('makes no call of its own: one read per session picked', async () => {
    mockApi.getSession.mockResolvedValue({ session: SESSION, transcript: TRANSCRIPT, assessment: assessment() });
    render(<Host assessments={[assessment()]} />);
    await settled();
    fireEvent.click(item(/^Stability/));
    expect(mockApi.getSession).toHaveBeenCalledTimes(1);
  });
});

describe('the height it keeps before the scorecard arrives', () => {
  const hang = () => mockApi.getSession.mockReturnValue(new Promise(() => undefined));

  it('holds the place, blank, while the candidate\'s own row says a scorecard is coming', () => {
    hang();
    render(<Host assessments={[assessment()]} />);
    const held = reserve()!;
    expect(held).toHaveAttribute('aria-hidden', 'true');
    expect(held.querySelectorAll('[data-header-ratings-cell]')).toHaveLength(6);
    // Not a figure, not a word.
    expect(slot().textContent).toBe('');
    expect(items()).toHaveLength(0);
  });

  it('gives way to the summary when the read answers', async () => {
    renderHost();
    await settled();
    expect(reserve()).toBeNull();
    expect(items()).toHaveLength(6);
  });

  it.each<[string, Partial<React.ComponentProps<typeof TranscriptionSyncWorkspace>>]>([
    ['while decision use is blocked', { blocked: true, assessments: [assessment()] }],
    ['for a legacy row', { assessments: [legacy()] }],
    ['for a row with no metric scored', { assessments: [assessment({}, { metricResults: [metricResult('m-a', 'Rapport', 10000, null)] })] }],
    ['with no scorecard to come', { assessments: [] }],
    ['for another call\'s row', { assessments: [assessment({ session_id: 'session-2' })] }],
    ['on an R1 session', { sessions: [{ ...SESSION, interview_round_id: 'round-1' }], assessments: [assessment()] }],
    ['on another tab', { active: false, assessments: [assessment()] }],
  ])('keeps no box %s', (_rule, props) => {
    hang();
    render(<Host {...props} />);
    expect(slot()).toBeEmptyDOMElement();
  });

  it('lets the place go when the read is refused and the row turns out to be another call\'s', async () => {
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const mine = assessment();
    const latest = assessment({ id: 'a2', session_id: 'session-2' });
    const newer: Session = { ...SESSION, id: 'session-2', created_at: '2026-10-07T03:30:00.000Z' };
    render(<Host sessions={[SESSION, newer]} assessments={[latest, mine]} />);
    expect(await screen.findByRole('heading', { name: 'Latest scorecard' })).toBeInTheDocument();
    expect(slot()).toBeEmptyDOMElement();
  });
});

describe('the floor under the panes', () => {
  const twenty = Array.from({ length: 20 }, (_, index) => metricResult(`m-${index}`, `Metric name ${index}`, 500, 3));
  const floor = () => [...document.querySelector('[data-review-workspace]')!.classList].filter((name) => name.includes('min-h-'));

  it('stays where it was with no summary in the header', async () => {
    renderHost({ card: null });
    await settled();
    expect(floor()).toEqual(['min-[1180px]:min-h-[34rem]']);
  });

  it('stays where it was on a page that offers the summary no place', async () => {
    mockApi.getSession.mockResolvedValue({ session: SESSION, transcript: TRANSCRIPT, assessment: assessment() });
    render(<TranscriptionSyncWorkspace sessions={[SESSION]} assessments={[]} blocked={false} candidateId="c1" />);
    await settled();
    expect(floor()).toEqual(['min-[1180px]:min-h-[34rem]']);
  });

  it('gives back the two rows a role of six metrics can take', async () => {
    renderHost();
    await settled();
    expect(floor()).toEqual(['min-[1180px]:min-h-[31rem]']);
  });

  it('gives back what 20 metrics, the most the API allows, can take', async () => {
    renderHost({ card: assessment({}, { metricResults: twenty }) });
    await settled();
    expect(floor()).toEqual(['min-[1180px]:min-h-[26.5rem]']);
  });

  it('is already there while the reserve holds the place, so the summary arriving moves nothing', () => {
    mockApi.getSession.mockReturnValue(new Promise(() => undefined));
    render(<Host assessments={[assessment()]} />);
    expect(reserve()).not.toBeNull();
    expect(floor()).toEqual(['min-[1180px]:min-h-[31rem]']);
  });
});

describe('pressing an item', () => {
  const pressed = async () => {
    await settled();
    return reasoning();
  };

  it('opens that row and moves focus to it', async () => {
    renderHost();
    await pressed();
    const toggle = within(row('m-prof')).getByRole('button', { name: 'Profile relevance' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(item(/^Profile relevance/));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();
  });

  it('leaves an open row open, and a second press does not close it', async () => {
    renderHost();
    await pressed();
    const toggle = within(row('m-prof')).getByRole('button', { name: 'Profile relevance' });
    fireEvent.click(item(/^Profile relevance/));
    fireEvent.click(item(/^Profile relevance/));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();
  });

  it('focuses the row itself when it has nothing to open', async () => {
    renderHost({ card: firm({}, { metricResults: [metricResult('m-a', 'Rapport', 10000, 3, [], null)] }) });
    await settled();
    expect(within(row('m-a')).queryByRole('button')).toBeNull();
    fireEvent.click(item(/^Rapport/));
    expect(row('m-a')).toHaveFocus();
  });

  it('plays nothing, mints nothing and cues nothing', async () => {
    renderHost({
      card: assessment(),
    });
    await pressed();
    const clockBefore = document.querySelector('[data-tape-clock]')?.textContent;
    const pressedBefore = [...document.querySelectorAll('[aria-pressed="true"]')].map((el) => el.outerHTML);
    fireEvent.click(item(/^Profile relevance/));
    fireEvent.click(item(/^Communication/));
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(document.querySelector('[data-tape-clock]')?.textContent).toBe(clockBefore);
    expect([...document.querySelectorAll('[aria-pressed="true"]')].map((el) => el.outerHTML)).toEqual(pressedBefore);
  });

  describe('bringing the row into the pane', () => {
    const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

    function laidOut(rowTop: number, scrolls = true) {
      const pane = reasoning();
      Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: () => (scrolls ? 2000 : 400) });
      Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 400 });
      const writes: number[] = [];
      Object.defineProperty(pane, 'scrollTop', { configurable: true, get: () => 100, set: (value: number) => writes.push(value) });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this === pane) return box(300, 400);
        if (this.hasAttribute('data-rubric-row')) return box(rowTop, 30);
        return box(0, 0);
      });
      return writes;
    }

    it('scrolls the pane to a row below its fold, leaving a margin', async () => {
      renderHost();
      await settled();
      const writes = laidOut(900);
      fireEvent.click(item(/^Stability/));
      expect(writes).toEqual([100 + 900 - 300 - 16]);
    });

    it('does not move a pane that already shows the row', async () => {
      renderHost();
      await settled();
      const writes = laidOut(400);
      fireEvent.click(item(/^Stability/));
      expect(writes).toEqual([]);
    });

    it('below 1180px the panes stack and the page scrolls, so the row is brought into the window', async () => {
      const scrollIntoView = vi.fn();
      (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
      try {
        renderHost();
        await settled();
        const writes = laidOut(5000, false);
        fireEvent.click(item(/^Stability/));
        expect(writes).toEqual([]);
        expect(scrollIntoView.mock.contexts[0]).toBe(row('m-stab'));
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
      } finally {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    });

    it('counts a row under the app bar as out of view, and leaves a row just clear of it', async () => {
      const scrollIntoView = vi.fn();
      (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
      try {
        renderHost();
        await settled();
        // jsdom has no stylesheet, so this is the margin the row's class sets below `lg`.
        row('m-stab').style.scrollMarginTop = '72px';

        laidOut(72, false);
        fireEvent.click(item(/^Stability/));
        expect(scrollIntoView).not.toHaveBeenCalled();

        laidOut(40, false);
        fireEvent.click(item(/^Stability/));
        expect(scrollIntoView.mock.contexts[0]).toBe(row('m-stab'));
      } finally {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    });
  });
});

describe('the place in the header', () => {
  function header(over: Partial<React.ComponentProps<typeof CandidateHeader>> = {}) {
    return (
      <CandidateHeader compact onRatingsSlot={() => undefined} title="Asha Rao" actions={<button type="button">Export report</button>} {...over} />
    );
  }

  /** Lay the header out as a browser would. jsdom has no layout, so the room is what these say. */
  function room({ row, who, actions }: { row: number; who: number; actions: number }) {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-ratings-fit') ? row : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = this.hasAttribute('data-header-who') ? who : this.hasAttribute('data-header-actions') ? actions : 0;
      return { top: 0, bottom: 0, left: 0, right: width, width, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
  }
  const fit = () => document.querySelector('[data-ratings-fit]')?.getAttribute('data-ratings-fit');

  it('chooses by the room left, not by whether there is an email', () => {
    room({ row: 1137, who: 400, actions: 120 });
    const { unmount } = render(header({ description: 'someone@example.com' }));
    expect(fit()).toBe('row');
    unmount();

    room({ row: 1137, who: 800, actions: 120 });
    render(header());
    expect(fit()).toBe('line');
  });

  it('takes the row at the room measured with no email, and its own line at the room with one', () => {
    expect(ratingsFit(607)).toBe('row');
    expect(ratingsFit(534)).toBe('row');
    expect(ratingsFit(392)).toBe('line');
  });

  it('offers no place unless compact: the fuller header has HeaderScore', () => {
    const offered = vi.fn();
    render(header({ compact: false, onRatingsSlot: offered }));
    expect(offered).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ratings-fit]')).toBeNull();
    expect(document.querySelector('[data-header-ratings]')).toBeNull();
  });

  it('hands its place over, and an empty place takes no room', () => {
    const offered = vi.fn();
    render(header({ onRatingsSlot: offered }));
    const place = document.querySelector<HTMLElement>('[data-header-ratings]')!;
    expect(offered).toHaveBeenCalledWith(place);
    expect(place).toBeEmptyDOMElement();
    expect(place).toHaveClass('empty:hidden');
  });

  it('keeps the page\'s plain header with no place asked for', () => {
    render(<CandidateHeader compact title="Asha Rao" actions={<button type="button">Export report</button>} />);
    expect(document.querySelector('[data-ratings-fit]')).toBeNull();
    expect(document.querySelector('[data-header-ratings]')).toBeNull();
  });
});
