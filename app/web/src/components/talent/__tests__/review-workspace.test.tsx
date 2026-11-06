/**
 * The Logsheet Review workspace on a phone session: the strip, the one cue, the two Legal-approved
 * wordings, and every state the screen can be in. Geometry, matching and the what-if arithmetic have
 * their own files; this is how they meet on the screen.
 */
import { render, screen, fireEvent, waitFor, within, configure } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

configure({ asyncUtilTimeout: 3000 });
import { TranscriptionSyncWorkspace } from '../TranscriptionSyncWorkspace';
import { RoleScorecardView } from '../../session/RoleScorecardView';
import type {
  AshbyCandidateWorkflow,
  AshbyCandidateWorkflowOperation,
  Assessment,
  CandidatePhoneAttempt,
  Session,
  TranscriptLine,
} from '../../../types';

const mockApi = { getSession: vi.fn(), getCandidatePhoneAttempts: vi.fn() };
const mockRecordingApi = { getRecordingDownloadUrl: vi.fn(), getAttemptRecordingDownloadUrl: vi.fn() };

vi.mock('../../../api', () => ({
  api: {
    getSession: (...args: unknown[]) => mockApi.getSession(...args),
    getRecordingDownloadUrl: (...args: unknown[]) => mockRecordingApi.getRecordingDownloadUrl(...args),
    getAttemptRecordingDownloadUrl: (...args: unknown[]) => mockRecordingApi.getAttemptRecordingDownloadUrl(...args),
    getCandidatePhoneAttempts: (...args: unknown[]) => mockApi.getCandidatePhoneAttempts(...args),
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
  recorded_total_sec: 245,
  recorded_legs: 2,
  recording_egress_started_at_ms: null,
};

/**
 * What GET /api/screening/:id really sends: the bare call_sessions row. The recorded roll-ups are
 * computed for the candidate read alone, so `SESSION` carries them and this does not.
 */
function bareRow(session: Session): Session {
  const row = { ...session };
  delete row.recorded_total_sec;
  delete row.recorded_legs;
  delete row.recorded_unknown_legs;
  return row;
}

const T0 = Date.parse('2026-10-05T03:30:00.000Z');
const RECONNECT = T0 + 200_000;

function leg(over: Partial<CandidatePhoneAttempt> & Pick<CandidatePhoneAttempt, 'id' | 'attempt_seq' | 'admitted_at'>): CandidatePhoneAttempt {
  return {
    answered_at: null,
    ended_at: null,
    state: 'completed',
    abandon_reason: null,
    outcome_class: null,
    duration_sec: null,
    connected_from: null,
    connected_to: null,
    connected_to_source: null,
    connected_sec: null,
    recorded_sec: null,
    recorded_sec_estimated: false,
    recording_started_at_ms: null,
    tail_may_be_missing: false,
    session_ref: 'session-1',
    recording: { state: 'ready' },
    consent_stage: 'after_consent',
    transcript: null,
    ...over,
  };
}

const CALL_ONE = leg({
  id: 'leg-1',
  attempt_seq: 1,
  outcome_class: 'disconnected',
  admitted_at: new Date(T0 - 10_000).toISOString(),
  answered_at: new Date(T0).toISOString(),
  connected_from: new Date(T0).toISOString(),
  connected_to: new Date(T0 + 100_000).toISOString(),
  connected_to_source: 'observed',
  recording_started_at_ms: T0,
  recorded_sec: 100,
});

const CALL_TWO = leg({
  id: 'leg-2',
  attempt_seq: 2,
  admitted_at: new Date(RECONNECT - 10_000).toISOString(),
  answered_at: new Date(RECONNECT).toISOString(),
  connected_from: new Date(RECONNECT).toISOString(),
  connected_to: new Date(RECONNECT + 45_000).toISOString(),
  connected_to_source: 'observed',
  recording_started_at_ms: RECONNECT,
  recorded_sec: 45,
});

/** Answered 29 hours before the real call: a voicemail leaves the session reusable, and the redial binds to it. */
const VOICEMAIL_AT = T0 - 29 * 3_600_000;
const VOICEMAIL = leg({
  id: 'leg-vm',
  attempt_seq: 1,
  outcome_class: 'voicemail',
  consent_stage: 'before_consent',
  admitted_at: new Date(VOICEMAIL_AT - 10_000).toISOString(),
  answered_at: new Date(VOICEMAIL_AT).toISOString(),
  connected_from: new Date(VOICEMAIL_AT).toISOString(),
  connected_to: new Date(VOICEMAIL_AT + 15_000).toISOString(),
  connected_to_source: 'observed',
  recording_started_at_ms: VOICEMAIL_AT,
  recorded_sec: 15,
});

/** Moved on a day, as a reconnect put off to the next can be. */
const DAY = 86_400_000;
const nextDay = (call: CandidatePhoneAttempt): CandidatePhoneAttempt => ({
  ...call,
  admitted_at: new Date(Date.parse(call.admitted_at) + DAY).toISOString(),
  answered_at: new Date(Date.parse(call.answered_at!) + DAY).toISOString(),
  connected_from: new Date(Date.parse(call.connected_from!) + DAY).toISOString(),
  connected_to: new Date(Date.parse(call.connected_to!) + DAY).toISOString(),
  recording_started_at_ms: call.recording_started_at_ms! + DAY,
});

const line = (speaker: TranscriptLine['speaker'], sec: number, text: string, is_gate = false): TranscriptLine => ({
  speaker,
  text,
  start_offset_sec: null,
  started_at_ms: T0 + sec * 1000,
  is_gate,
});

const TRANSCRIPT: TranscriptLine[] = [
  line('bot', 1, 'This call is recorded. Is that all right?', true),
  line('candidate', 8, 'Who is calling please?', true),
  line('bot', 12, 'Christy, an AI interviewer. Do you consent?', true),
  line('candidate', 20, 'Yes, I consent.', true),
  line('bot', 25, 'What is your monthly target?'),
  line('candidate', 30, 'My target is twelve a month and I usually reach it.'),
  line('bot', 40, 'What do you say when the fee feels too high?'),
  line('candidate', 46, 'I tell them about the EMI option first.'),
  line('bot', 210, 'Welcome back. How do you close?'),
  line('candidate', 216, 'I book the follow-up before we hang up.'),
];

function metricResult(id: string, name: string, weightBps: number, score: number | null, evidenceRefs: string[], rationale = `${name} rationale.`) {
  return {
    configMetricId: id,
    score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale,
    evidenceRefs,
    metric: { id, name, weightBps },
  };
}

// (2500*4 + 2500*3 + 2500*2) / 7500 = 3 -> 67: 67 is Select. One metric is missing, 25%.
const RESULTS = [
  metricResult('m-target', 'Target clarity', 2500, 4, ['My target is twelve a month']),
  metricResult('m-objection', 'Objection handling', 2500, 2, ['the EMI option first', 'words that were never said']),
  metricResult('m-rapport', 'Rapport', 2500, 3, ['book the follow-up']),
  metricResult('m-closing', 'Closing', 2500, null, []),
];

function assessment(over: Partial<Assessment> & Record<string, unknown> = {}): Assessment {
  return {
    id: 'a1',
    session_id: 'session-1',
    schema_version: 2,
    scoring_status: 'incomplete_evidence',
    overall_score: 67,
    recommendation: 'advance',
    summary: '',
    role_fit: { score: 0, matched_skills: [], gaps: [], red_flags: [], notes: '' },
    raw: {
      schemaVersion: 2,
      status: 'incomplete_evidence',
      scoreScaleMax: 4,
      metricResults: RESULTS,
      weightedScore5: 3,
      overallScore: 67,
      recommendation: 'advance',
    },
    ...over,
  } as unknown as Assessment;
}

function renderWorkspace({
  card = assessment(),
  transcript = TRANSCRIPT,
  legs = [CALL_ONE, CALL_TWO],
  session = SESSION,
  ...props
}: Partial<React.ComponentProps<typeof TranscriptionSyncWorkspace>> & {
  card?: Assessment | null;
  transcript?: TranscriptLine[];
  legs?: CandidatePhoneAttempt[];
  session?: Session;
} = {}) {
  mockApi.getSession.mockResolvedValue({ session: bareRow(session), transcript, assessment: card });
  mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: legs, next_cursor: null });
  return render(
    <TranscriptionSyncWorkspace
      sessions={[session]}
      assessments={card ? [card] : []}
      blocked={false}
      candidateId="c1"
      candidateName="Asha Rao"
      roleTitle="Sales Advisor"
      {...props}
    />,
  );
}

const ticks = () => [...document.querySelectorAll('[data-strip-tick]')];
const tick = (n: number) => document.querySelector<HTMLElement>(`[data-strip-tick="${n}"]`)!;
const chip = (n: number) => document.querySelector<HTMLElement>(`[data-seek-chip="${n}"]`)!;
const clock = () => document.querySelector('[data-tape-clock]')!.textContent;
const playhead = () => document.querySelector<HTMLElement>('[data-playhead]')!.style.left;
const turnButton = (n: number) => screen.getByRole('button', { name: new RegExp(`^Turn ${n}:`) });
const tapeStatus = () => document.querySelector<HTMLElement>('[data-tape-status]')!;
const pane = (name: 'transcript' | 'reasoning') => document.querySelector<HTMLElement>(`[data-review-pane="${name}"]`)!;
const box = (top: number) => ({ top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

/** Lay out what jsdom will not: the box of whatever `place` names, and zero for the rest. */
function layout(place: (el: HTMLElement) => number | null) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return box(place(this) ?? 0);
  });
}

/** Every value written to this element's scrollTop. */
function scrollWrites(el: HTMLElement): number[] {
  const writes: number[] = [];
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => 0, set: (value: number) => writes.push(value) });
  return writes;
}
const activeTurns = () => [...document.querySelectorAll('[data-turn-row] [aria-current="true"]')].map((el) => el.closest('[data-turn-row]')!.getAttribute('data-turn-row'));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { __allowConsole?: (pattern: RegExp) => void }).__allowConsole?.(/inside a test was not wrapped in act/);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 2 });
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get: () => 0, set: () => undefined });
  mockRecordingApi.getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/leg' });
  mockRecordingApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/session' });
});

describe('the log header', () => {
  it('prints the role, the screening, the interviewer, the length and the drop', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    const header = document.querySelector<HTMLElement>('[data-log-header]')!;
    expect(within(header).getByText('Sales Advisor')).toBeInTheDocument();
    expect(within(header).getByText('Christy (AI)')).toBeInTheDocument();
    expect(header).toHaveTextContent('Recorded 4m 5s across 2 calls · line dropped once');
  });

  it('reads the length from the list row: the loaded row has no recorded total', async () => {
    const lone: Session = { ...SESSION, recorded_legs: 1, recorded_total_sec: 90 };
    renderWorkspace({ session: lone, legs: [CALL_ONE] });
    await screen.findByText('What is your monthly target?');
    await expect(mockApi.getSession.mock.results[0].value).resolves.not.toHaveProperty('session.recorded_total_sec');
    expect(screen.getByText('Length').parentElement).toHaveTextContent('Recorded 1m 30s');
  });

  it('with no recorded total anywhere the strip gives an estimate, never "Not known" over a strip', async () => {
    // The scoped Ashby read of a worker session: bare rows in the list too, no legs, stamps and no offsets.
    renderWorkspace({ session: bareRow(SESSION), legs: [], candidateId: undefined });
    await screen.findByText('What is your monthly target?');
    expect(document.querySelector('[data-call-strip]')).not.toBeNull();
    expect(screen.getByText('Length').parentElement).toHaveTextContent(/^Length≈\d+m \d+s$/);
  });

  it('a host with no way to read the role drops the cell, and one that could not resolve it says so', async () => {
    const { unmount } = renderWorkspace({ roleTitle: undefined });
    await screen.findByText('What is your monthly target?');
    expect(screen.queryByText('Role')).toBeNull();
    unmount();

    renderWorkspace({ roleTitle: null });
    await screen.findByText('What is your monthly target?');
    expect(screen.getByText('Role').parentElement).toHaveTextContent('Not available');
  });

  it('says "Not linked" only when the read says so, and a neutral word when the read failed', async () => {
    const { unmount } = renderWorkspace({ ashbyWorkflow: null });
    await screen.findByText('What is your monthly target?');
    expect(screen.getByText('In Ashby').parentElement).toHaveTextContent('Not linked');
    unmount();

    renderWorkspace({ ashbyWorkflow: undefined });
    await screen.findByText('What is your monthly target?');
    expect(screen.getByText('In Ashby').parentElement).toHaveTextContent('Not available');
  });

  it('says where the candidate stands in Ashby and when the scorecard went, in IST', async () => {
    renderWorkspace({
      ashbyWorkflow: {
        lifecycle: 'completed',
        terminalState: null,
        ingestionState: null,
        operations: [
          {
            type: 'scorecard_write',
            state: 'succeeded',
            errorCode: null,
            updatedAt: '2026-10-05T06:28:00.000Z',
            sessionCreatedAt: SESSION.created_at,
          },
        ],
        sessionStatus: 'completed',
        updatedAt: null,
      },
    });
    await screen.findByText('What is your monthly target?');
    expect(screen.getByText('In Ashby').parentElement).toHaveTextContent('Screening complete · AI scorecard sent 11:58 IST');
  });

  describe('"AI scorecard sent" belongs to the session the write came from', () => {
    const workflow = (over: Partial<AshbyCandidateWorkflowOperation>): AshbyCandidateWorkflow => ({
      lifecycle: 'completed',
      terminalState: null,
      ingestionState: null,
      operations: [
        {
          type: 'scorecard_write',
          state: 'succeeded',
          errorCode: null,
          updatedAt: '2026-10-05T06:28:00.000Z',
          sessionCreatedAt: SESSION.created_at,
          ...over,
        },
      ],
      sessionStatus: 'completed',
      updatedAt: null,
    });
    const cell = () => screen.getByText('In Ashby').parentElement!;

    it("says nothing over another session: a link holds one write, and it is not this re-screen's", async () => {
      renderWorkspace({ ashbyWorkflow: workflow({ sessionCreatedAt: '2026-09-01T03:30:00.000Z', updatedAt: '2026-09-01T06:28:00.000Z' }) });
      await screen.findByText('What is your monthly target?');
      expect(cell()).toHaveTextContent('Screening complete');
      expect(cell()).not.toHaveTextContent('sent');
    });

    it('says nothing when the API could not say which session it was', async () => {
      renderWorkspace({ ashbyWorkflow: workflow({ sessionCreatedAt: undefined }) });
      await screen.findByText('What is your monthly target?');
      expect(cell()).not.toHaveTextContent('sent');
    });

    it('never stands over the hold notice', async () => {
      const card = assessment({ evidence_grade: 'insufficient' });
      renderWorkspace({ card, ashbyWorkflow: workflow({}) });
      expect(await screen.findByText(/it was not sent to Ashby/)).toBeInTheDocument();
      expect(cell()).not.toHaveTextContent('sent');
    });

    it("gives the date when the write did not land on the session's own day", async () => {
      renderWorkspace({ ashbyWorkflow: workflow({ updatedAt: '2026-10-07T06:28:00.000Z' }) });
      await screen.findByText('What is your monthly target?');
      expect(cell()).toHaveTextContent('AI scorecard sent 7 Oct 2026, 11:58 IST');
    });
  });

  describe('the In Ashby cell says its state in colour, and only that cell', () => {
    const workflow = (lifecycle: AshbyCandidateWorkflow['lifecycle'], sent = false): AshbyCandidateWorkflow => ({
      lifecycle,
      terminalState: null,
      ingestionState: null,
      operations: sent
        ? [
            {
              type: 'scorecard_write',
              state: 'succeeded',
              errorCode: null,
              updatedAt: '2026-10-05T06:28:00.000Z',
              sessionCreatedAt: SESSION.created_at,
            },
          ]
        : [],
      sessionStatus: 'completed',
      updatedAt: null,
    });

    it('prints "Writing results back to Ashby" in moving', async () => {
      renderWorkspace({ ashbyWorkflow: workflow('writeback_pending') });
      await screen.findByText('What is your monthly target?');
      expect(screen.getByText('Writing results back to Ashby')).toHaveClass('text-moving-text');
    });

    it('prints "AI scorecard sent" in ready, and the same state word as the workflow card does', async () => {
      renderWorkspace({ ashbyWorkflow: workflow('completed', true) });
      await screen.findByText('What is your monthly target?');
      const cell = screen.getByText('In Ashby').parentElement!;
      expect(cell).toHaveTextContent('Screening complete · AI scorecard sent 11:58 IST');
      expect(within(cell).getByText('AI scorecard sent 11:58 IST')).toHaveClass('text-ready-text');
      expect(within(cell).getByText('Screening complete')).toHaveClass('text-success-text');
    });

    it.each([
      ['Not linked', null],
      ['Not available', undefined],
    ])('leaves %s in ink', async (word, ashbyWorkflow) => {
      renderWorkspace({ ashbyWorkflow });
      await screen.findByText('What is your monthly target?');
      const cell = screen.getByText('In Ashby').parentElement!;
      expect(cell).toHaveTextContent(word);
      expect(cell.innerHTML).not.toMatch(/moving|ready|success|closed|unresolved|warning/);
    });

    it('colours no consent line', async () => {
      renderWorkspace({ ashbyWorkflow: workflow('completed', true) });
      await screen.findByText('What is your monthly target?');
      expect(document.querySelector('[data-consent-line]')!.innerHTML).not.toMatch(/moving|ready|success|closed|unresolved|warning/);
    });
  });

  describe('an evidence number takes the family of the rating it cites', () => {
    // Target clarity 4 of 4, Objection handling 2 of 4, Rapport 1 of 4.
    const results = [
      metricResult('m-target', 'Target clarity', 2500, 4, ['My target is twelve a month']),
      metricResult('m-objection', 'Objection handling', 2500, 2, ['the EMI option first']),
      metricResult('m-rapport', 'Rapport', 2500, 1, ['book the follow-up']),
    ];
    const card = (metricResults = results) =>
      assessment({ raw: { ...assessment().raw, metricResults } as Assessment['raw'] });
    const margin = (name: RegExp) => screen.getByRole('button', { name });

    it.each([
      [1, 'ready'],
      [2, 'unresolved'],
      [3, 'closed'],
    ])('tick %s is paper with the %s family', async (number, family) => {
      renderWorkspace({ card: card() });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      // Review opens with the weakest metric's quote cued, so cue another to see this one at rest.
      const other = number === 1 ? 2 : 1;
      fireEvent.click(tick(other));
      await waitFor(() => expect(tick(other)).toHaveAttribute('aria-pressed', 'true'));
      expect(tick(number)).toHaveClass('bg-paper', `border-${family}`, `text-${family}-text`);
    });

    it('fills a pressed tick with its family, in paper text, not with ink', async () => {
      renderWorkspace({ card: card() });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      fireEvent.click(tick(3));
      await waitFor(() => expect(tick(3)).toHaveAttribute('aria-pressed', 'true'));
      expect(tick(3)).toHaveClass('bg-closed-text', 'text-paper');
      expect(tick(3)).not.toHaveClass('bg-ink');
    });

    it('prints the same family in the transcript margin', async () => {
      renderWorkspace({ card: card() });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      fireEvent.click(tick(1));
      await waitFor(() => expect(tick(1)).toHaveAttribute('aria-pressed', 'true'));
      expect(margin(/^Evidence 1, Target clarity/)).toHaveClass('bg-ready-text', 'text-paper', 'border-ready-text');
      expect(margin(/^Evidence 2, Objection handling/)).toHaveClass('bg-paper', 'text-unresolved-text', 'border-unresolved');
      expect(margin(/^Evidence 3, Rapport/)).toHaveClass('bg-paper', 'text-closed-text', 'border-closed');
    });

    it('prints the same family on the rubric quote row, keeping its row edge in ink when pressed', async () => {
      renderWorkspace({ card: card() });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      fireEvent.click(tick(2));
      const quote = await waitFor(() => {
        const row = document.querySelector<HTMLElement>('[data-quote-button="2"]');
        expect(row).toHaveAttribute('aria-pressed', 'true');
        return row!;
      });
      expect(quote.querySelector('[data-evidence-number]')).toHaveClass('bg-unresolved-text', 'text-paper');
      expect(quote).toHaveClass('border-ink');
    });

    it('keeps a metric with no score in ink', async () => {
      renderWorkspace({
        card: card([results[0], metricResult('m-objection', 'Objection handling', 2500, null, ['the EMI option first'])]),
      });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expect(tick(2)).toHaveClass('bg-paper', 'border-ink', 'text-ink');
      expect(margin(/^Evidence 2, Objection handling/)).toHaveClass('border-ink', 'text-ink');
    });

    it('changes nothing else on the strip: the wash, the voice segments, the grey segments and the hatch', async () => {
      renderWorkspace({ card: card() });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expect(document.querySelector('[data-strip-segment="candidate"]')).toHaveAttribute('fill', 'var(--voice-mark)');
      expect(document.querySelector('[data-strip-segment="ai"]')).toHaveAttribute('fill', 'var(--ai)');
      expect(document.querySelector('[data-strip-segment="gate"]')?.getAttribute('fill')).toMatch(/^url\(/);
      expect(document.querySelector('[data-evidence-mark]')).toHaveClass('bg-wash');
    });
  });

  it('a scorecard that has not reached Ashby is not said to have been sent', async () => {
    renderWorkspace({
      ashbyWorkflow: {
        lifecycle: 'writeback_pending',
        terminalState: null,
        ingestionState: null,
        operations: [{ type: 'scorecard_write', state: 'failed', errorCode: 'provider_5xx', updatedAt: '2026-10-05T06:28:00.000Z' }],
        sessionStatus: 'completed',
        updatedAt: null,
      },
    });
    await screen.findByText('What is your monthly target?');
    expect(screen.getByText('In Ashby').parentElement).not.toHaveTextContent('sent');
  });

  it('the session picker is the combobox, and choosing a session loads it', async () => {
    const other: Session = { ...SESSION, id: 'session-2', created_at: '2026-10-06T03:30:00.000Z' };
    renderWorkspace({ sessions: [SESSION, other] });
    await screen.findByText('What is your monthly target?');
    expect(document.querySelector('select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Screening/ }));
    fireEvent.click(screen.getAllByRole('option')[1]);
    await waitFor(() => expect(mockApi.getSession).toHaveBeenCalledWith('session-2'));
  });
});

describe('the call strip', () => {
  it('draws the candidate, the interviewer, the consent gate and the drop, each as itself', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    const kinds = [...document.querySelectorAll('[data-strip-segment]')].map((el) => el.getAttribute('data-strip-segment'));
    expect(kinds.slice(0, 4)).toEqual(['gate', 'gate', 'gate', 'gate']);
    expect(kinds).toContain('ai');
    expect(kinds).toContain('candidate');
    expect(document.querySelectorAll('[data-strip-drop]')).toHaveLength(1);

    const candidate = document.querySelector('[data-strip-segment="candidate"]')!;
    const ai = document.querySelector('[data-strip-segment="ai"]')!;
    expect(candidate.getAttribute('height')).toBe('24');
    expect(ai.getAttribute('height')).toBe('8');
  });

  it('has one numbered tick per placed quote, and none for a quote that could not be placed', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    expect(ticks()).toHaveLength(3);
    expect(tick(2)).toHaveAccessibleName('Evidence 2: turn 8 at 00:46, Objection handling');
  });

  it('carries a text alternative with the length, the share, consent, the drop and the quote count', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    const strip = screen.getByRole('img');
    expect(strip).toHaveAccessibleName(/^Call strip: 4 min 5 s across 2 calls\. Asha spoke about .*% of the talk\./);
    expect(strip).toHaveAccessibleName(/Consent given at 00:20\./);
    expect(strip).toHaveAccessibleName(/Line dropped at 01:40 and reconnected at 03:20\./);
    expect(strip).toHaveAccessibleName(/3 evidence quotes\.$/);
  });

  it('stops the last turn before a drop at the drop, however long its words', async () => {
    const cutOff: TranscriptLine = line('candidate', 98, 'x'.repeat(300));
    renderWorkspace({ transcript: [...TRANSCRIPT.slice(0, 8), cutOff, ...TRANSCRIPT.slice(8)] });
    await screen.findByText('What is your monthly target?');
    const drawn = [...document.querySelectorAll('[data-strip-segment="candidate"]')].find(
      (el) => Math.abs(parseFloat(el.getAttribute('x')!) - (98 / 245) * 100) < 0.01,
    )!;
    // The line dropped at 100 s, two seconds in: the estimate alone would have run to 116 s.
    expect(parseFloat(drawn.getAttribute('width')!)).toBeCloseTo((2 / 245) * 100, 3);
  });

  describe('a gap between calls that no drop explains', () => {
    const finished = { ...CALL_ONE, outcome_class: 'completed' };

    it('claims no drop anywhere: header, strip, words, call group or Check before deciding', async () => {
      renderWorkspace({ legs: [finished, CALL_TWO] });
      const check = (await screen.findByRole('heading', { name: 'Check before deciding' })).parentElement!.parentElement!;
      expect(document.querySelector('[data-log-header]')).not.toHaveTextContent(/line dropped/i);
      expect(document.querySelector('[data-strip-drop]')).toBeNull();
      expect(screen.queryByText('Line dropped')).toBeNull();
      expect(screen.queryByText(/the call continued/)).toBeNull();
      expect(check).not.toHaveTextContent(/line dropped/i);
      const strip = screen.getByRole('img');
      expect(strip).not.toHaveAccessibleName(/Line dropped|reconnected/);
      expect(strip).toHaveAccessibleName(/across 2 calls\./);
      expect(strip).toHaveAccessibleName(/Next call at 03:20\./);
    });

    it('keeps the turns of both calls where they were', async () => {
      renderWorkspace({ legs: [finished, CALL_TWO] });
      await screen.findByText('What is your monthly target?');
      expect(clock()).toContain('04:05');
      expect(turnButton(10)).toHaveTextContent('03:36');
    });

    it('calls the later call plain "Call 2 of 2": nothing was cut off to reconnect', async () => {
      renderWorkspace({ legs: [finished, CALL_TWO] });
      expect(await screen.findByRole('group', { name: 'Call 2 of 2' })).toBeInTheDocument();
      expect(screen.queryByText(/reconnect/)).toBeNull();
    });

    it('cuts one too long to draw even with no talk before it and an end nobody saw, and still claims no end', async () => {
      const unseen = { ...finished, connected_to: null, connected_to_source: 'unobserved' as const, recorded_sec: null };
      renderWorkspace({
        legs: [unseen, nextDay(CALL_TWO)],
        // Every turn on the second call, so nobody spoke on the first.
        transcript: TRANSCRIPT.map((turn) => ({ ...turn, started_at_ms: turn.started_at_ms! + DAY + 200_000 })),
      });
      await screen.findByText('What is your monthly target?');
      expect(document.querySelector('[data-strip-break]')).not.toBeNull();
      // To scale the interview would start 99% of the way along.
      expect(parseFloat(document.querySelector('[data-strip-segment]')!.getAttribute('x')!)).toBeLessThan(10);
      const strip = screen.getByRole('img');
      expect(strip).toHaveAccessibleName(/Next call at 24:03:20\./);
      expect(strip).not.toHaveAccessibleName(/Line dropped/);
    });
  });

  describe('a voicemail between the drop and the call that carried it on', () => {
    // The line goes at 01:40, a voicemail answers at 02:30, the interview goes on at 03:20.
    const between = leg({
      id: 'leg-between',
      attempt_seq: 2,
      outcome_class: 'voicemail',
      consent_stage: 'before_consent',
      admitted_at: new Date(T0 + 140_000).toISOString(),
      answered_at: new Date(T0 + 150_000).toISOString(),
      connected_from: new Date(T0 + 150_000).toISOString(),
      connected_to: new Date(T0 + 170_000).toISOString(),
      connected_to_source: 'observed',
      recording_started_at_ms: T0 + 150_000,
      recorded_sec: 20,
    });
    const legs = [CALL_ONE, between, { ...CALL_TWO, attempt_seq: 3 }];

    it('says the call continued where it did, and nothing of the voicemail', async () => {
      renderWorkspace({ legs });
      const carried = await screen.findByRole('group', { name: 'Call 3 of 3 · reconnect' });
      expect(within(carried).getByText('Line dropped at 01:40; the call continued at 03:20')).toBeInTheDocument();
      expect(screen.queryByText(/continued at 02:30/)).toBeNull();
      const check = screen.getByRole('heading', { name: 'Check before deciding' }).parentElement!.parentElement!;
      expect(check).toHaveTextContent('Line dropped at 01:40; the call continued at 03:20');
      expect(document.querySelector('[data-log-header]')).toHaveTextContent('line dropped once');
    });

    it('keeps the voicemail a plain gap on the strip and a plain call in the list', async () => {
      renderWorkspace({ legs });
      const list = await screen.findByRole('list', { name: 'Calls in this session' });
      expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('Call 2 of 3');
      expect(within(list).getAllByRole('listitem')[1]).not.toHaveTextContent('reconnect');
      const strip = screen.getByRole('img');
      expect(strip).toHaveAccessibleName(/Line dropped at 01:40 and reconnected at 03:20\./);
      expect(strip).toHaveAccessibleName(/Next call at 02:30\./);
      expect(document.querySelectorAll('[data-strip-drop]')).toHaveLength(1);
    });
  });

  it('draws no strip for turns with no time, and the transcript still reads', async () => {
    renderWorkspace({
      legs: [],
      transcript: [{ speaker: 'candidate', text: 'Untimed words.', start_offset_sec: null }],
    });
    await screen.findByText('Untimed words.');
    expect(document.querySelector('[data-call-strip]')).toBeNull();
  });
});

describe('a voicemail the redial came after', () => {
  const legs = [VOICEMAIL, CALL_ONE, CALL_TWO];
  const notice: TranscriptLine = { speaker: 'bot', text: 'This call is recorded.', start_offset_sec: null, started_at_ms: VOICEMAIL_AT + 5000, is_gate: true };

  it('leaves the consent line and every time on the page as they were', async () => {
    renderWorkspace({ legs });
    await screen.findByText('What is your monthly target?');
    const row = document.querySelector<HTMLElement>('[data-consent-line]')!;
    expect(within(row).getByText('Consent given at 00:20')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Show 4 turns' })).toBeInTheDocument();
    expect(chip(1)).toHaveTextContent('T6 · 00:30');
    expect(turnButton(10)).toHaveTextContent('03:36');
    expect(clock()).toBe('00:46 / 04:05');
    expect(tick(3)).toHaveAccessibleName('Evidence 3: turn 10 at 03:36, Rapport');
    expect(screen.getAllByText('Line dropped at 01:40; the call continued at 03:20')).toHaveLength(2);
  });

  it('gives the strip the length the header gives, and says nothing of the wait', async () => {
    renderWorkspace({ legs });
    await screen.findByText('What is your monthly target?');
    expect(document.querySelector('[data-log-header]')).toHaveTextContent('Recorded 4m 5s across 2 calls · line dropped once');
    const strip = screen.getByRole('img');
    expect(strip).toHaveAccessibleName(/^Call strip: 4 min 5 s across 2 calls\. /);
    expect(strip).toHaveAccessibleName(/Consent given at 00:20\./);
    expect(strip).not.toHaveAccessibleName(/Next call/);
    expect(document.querySelector('[data-strip-break]')).toBeNull();
  });

  it('counts only the calls the strip draws', async () => {
    renderWorkspace({ legs: [VOICEMAIL, { ...CALL_ONE, outcome_class: 'completed' }], transcript: TRANSCRIPT.slice(0, 8) });
    await screen.findByText('What is your monthly target?');
    expect(screen.getByRole('img')).toHaveAccessibleName(/^Call strip: 1 min 40 s\. /);
  });

  it('stays in the calls list, and the only real call after it is no reconnect', async () => {
    renderWorkspace({ legs: [VOICEMAIL, { ...CALL_ONE, outcome_class: 'completed' }], transcript: TRANSCRIPT.slice(0, 8) });
    const list = await screen.findByRole('list', { name: 'Calls in this session' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Call 1 of 2 · first call');
    expect(first).toHaveTextContent('Recorded before consent');
    expect(second).toHaveTextContent('Call 2 of 2');
    expect(second).not.toHaveTextContent('reconnect');
    expect(screen.getByRole('group', { name: 'Call 2 of 2' })).toBeInTheDocument();
  });

  it('says "End not observed" of it, not that a line dropped', async () => {
    const unseen = { ...VOICEMAIL, connected_to_source: 'unobserved' as const };
    renderWorkspace({ legs: [unseen, CALL_ONE, CALL_TWO] });
    const list = await screen.findByRole('list', { name: 'Calls in this session' });
    const [first] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent(/End not observed \(detected \d\d:\d\d IST by timeout\)\./);
    expect(first).not.toHaveTextContent('Line dropped');
  });

  it('plays on its own file, and the strip never reads that file as the interview', async () => {
    renderWorkspace({ legs });
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: 'Load recording, Call 1 of 3' }));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-vm');

    const audio = document.querySelector('audio')!;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 12, set: () => undefined });
    fireEvent.play(audio);
    fireEvent.timeUpdate(audio);
    await waitFor(() => expect(clock()).toBe('00:00 / 04:05'));
    expect(playhead()).toBe('0%');
    expect(document.querySelector('[data-tape-consent]')).toHaveTextContent('Recorded before consent');

    fireEvent.pause(audio);
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Play from/ })).toBeNull();
  });

  it('a turn on it cues its own file, and the tape names no moment it will not play', async () => {
    const seeks: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get: () => 0, set: (sec: number) => seeks.push(sec) });
    renderWorkspace({ legs, transcript: [notice, ...TRANSCRIPT] });
    await screen.findByText('What is your monthly target?');
    // Its margin is the position in its own file: it has none on the clock.
    expect(turnButton(1)).toHaveTextContent('00:05');
    fireEvent.click(tick(3));
    expect(clock()).toBe('03:36 / 04:05');

    fireEvent.click(turnButton(1));
    expect(clock()).toBe('00:00 / 04:05');
    expect(playhead()).toBe('0%');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(document.querySelector('[data-tape-consent]')).toHaveTextContent('Recorded before consent');
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-vm'));
    await waitFor(() => expect(seeks).toContain(5));
  });

  it('a notice read to it stays in full, and the real call keeps its line', async () => {
    renderWorkspace({ legs, transcript: [notice, ...TRANSCRIPT] });
    expect(await screen.findByText('This call is recorded.')).toBeInTheDocument();
    const row = document.querySelector<HTMLElement>('[data-consent-line]')!;
    expect(within(row).getByText('Consent given at 00:20')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Show 4 turns' })).toBeInTheDocument();
    expect(row).toHaveTextContent('T2–5');
  });

  it('with no call past consent the first is the clock, and nothing claims consent', async () => {
    const refused = { ...CALL_ONE, outcome_class: 'consent_failed', consent_stage: 'before_consent' as const };
    renderWorkspace({ legs: [VOICEMAIL, refused], transcript: TRANSCRIPT.slice(0, 8) });
    expect(await screen.findByText('Yes, I consent.')).toBeInTheDocument();
    expect(screen.queryByText(/Consent given/)).toBeNull();
    expect(screen.getByRole('img')).toHaveAccessibleName(/^Call strip: 29 h /);
  });
});

describe('one cue, everywhere at once', () => {
  it('opens on the weakest metric first quote, with nothing played and nothing minted', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    expect(clock()).toContain('00:46');
    expect(screen.getByRole('button', { name: /^Play from/ })).toHaveTextContent('Play from 00:46');
    expect(tick(2)).toHaveAttribute('aria-pressed', 'true');
    expect(activeTurns()).toEqual(['8']);
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    // Nothing is playing, so nothing says it is.
    expect(screen.queryByText(/^Now playing/)).toBeNull();
  });

  it.each([
    ['a tick', () => tick(3)],
    ['a seek chip', () => chip(3)],
    ['a margin number', () => screen.getByRole('button', { name: 'Evidence 3, Rapport' })],
  ])('%s moves the playhead, the clock, the turn and the pressed quote in the same commit', async (_what, control) => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(control());
    // No waiting: the audio has not answered, and everything has already moved.
    expect(clock()).toContain('03:36');
    expect(screen.getByRole('button', { name: /^Play from|^Pause/ })).toBeInTheDocument();
    expect(activeTurns()).toEqual(['10']);
    expect(tick(3)).toHaveAttribute('aria-pressed', 'true');
    expect(tick(2)).toHaveAttribute('aria-pressed', 'false');
    expect(playhead()).toBe(`${(216 / 245) * 100}%`);
  });

  it('a timecode cues its turn and presses no quote', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(turnButton(7));
    expect(clock()).toContain('00:40');
    expect(activeTurns()).toEqual(['7']);
    expect(ticks().filter((el) => el.getAttribute('aria-pressed') === 'true')).toEqual([]);
  });

  it('a press plays that moment on the call it lives in, minting only that call', async () => {
    const seeks: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: (sec: number) => seeks.push(sec),
    });
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(3));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-2'));
    await waitFor(() => expect(seeks).toContain(16));
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalledWith('leg-1');
  });

  it('a press opens the metric its quote belongs to, and its button shows pressed', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    expect(document.querySelector('[data-quote-button="1"]')).toBeNull();
    fireEvent.click(tick(1));
    expect(document.querySelector('[data-quote-button="1"]')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a seek leaves keyboard focus on the control that was pressed', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    const pressed = tick(3);
    pressed.focus();
    fireEvent.click(pressed);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(pressed).toHaveFocus();
    // jsdom cannot focus an <audio>, so the attempt is what has to be looked for.
    expect(focus.mock.contexts.filter((el) => el instanceof HTMLAudioElement)).toEqual([]);
  });

  it('"Play from" mints on the press and plays the cued moment, then offers Pause', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: /^Play from/ }));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-1'));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    fireEvent.play(document.querySelector('audio')!);
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('the playhead follows the audio along the whole call, across a drop', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(3));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    const audio = document.querySelector('audio')!;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 20, set: () => undefined });
    fireEvent.timeUpdate(audio);
    await waitFor(() => expect(clock()).toContain('03:40'));
  });
});

describe('when a file runs out', () => {
  /** Run the audio to the end of a file, in the order a browser reports it. */
  function runOut(audio: HTMLAudioElement, sec: number) {
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => sec, set: () => undefined });
    fireEvent.play(audio);
    fireEvent.timeUpdate(audio);
    fireEvent.pause(audio);
    fireEvent.ended(audio);
  }

  it('Play moves on to the next call, says so, and plays it from its start', async () => {
    const seeks: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: (sec: number) => seeks.push(sec),
    });
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(1));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());

    runOut(document.querySelector('audio')!, 100);
    const play = await screen.findByRole('button', { name: /^Play from/ });
    expect(play).toHaveTextContent('Play from 03:20');
    expect(clock()).toContain('03:20');

    seeks.length = 0;
    fireEvent.click(play);
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-2'));
    await waitFor(() => expect(seeks).toContain(0));
  });

  it('a press on the last moment of a file stays lit when the file ends at once', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(1));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());

    runOut(document.querySelector('audio')!, 30);
    await screen.findByRole('button', { name: /^Play from/ });
    expect(activeTurns()).toEqual(['6']);
    expect(tick(1)).toHaveAttribute('aria-pressed', 'true');
  });

  it('after the last call Play goes back to the start of the session', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(3));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());

    runOut(document.querySelector('audio')!, 45);
    const play = await screen.findByRole('button', { name: /^Play from/ });
    expect(play).toHaveTextContent('Play from 00:00');
    fireEvent.click(play);
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-1'));
  });

  it('a single session recording goes back to its start', async () => {
    renderWorkspace({ legs: [], candidateId: undefined, transcript: TRANSCRIPT.map((turn, at) => ({ ...turn, started_at_ms: null, start_offset_sec: at * 5 })) });
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(1));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());

    runOut(document.querySelector('audio')!, 60);
    expect(await screen.findByRole('button', { name: /^Play from/ })).toHaveTextContent('Play from 00:00');
  });

  it('a cue on its way outranks the file running out', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(1));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    const callOne = document.querySelector('audio')!;
    fireEvent.play(callOne);
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockReturnValue(new Promise(() => undefined));

    fireEvent.click(tick(3));
    fireEvent.ended(callOne);
    expect(clock()).toContain('03:36');
    expect(activeTurns()).toEqual(['10']);
  });
});

describe('where Play starts with nothing cued', () => {
  const beforeConsent = { ...CALL_ONE, outcome_class: 'voicemail', consent_stage: 'before_consent' as const };
  const tapeTag = () => document.querySelector('[data-tape-consent]');

  it('passes over a clip from before consent while another can play', async () => {
    renderWorkspace({ card: null, legs: [beforeConsent, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-2'));
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).not.toHaveBeenCalledWith('leg-1');
    expect(tapeTag()).toBeNull();
  });

  it('plays it only when nothing else can, and then the tape carries its tag, word for word', async () => {
    const noAudio = { state: 'unavailable' as const, reason: 'recording_failed' as const };
    renderWorkspace({ card: null, legs: [beforeConsent, { ...CALL_TWO, recording: noAudio }] });
    await screen.findByText('What is your monthly target?');
    expect(tapeTag()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(tapeTag()).toHaveTextContent('Recorded before consent');
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-1'));
  });

  it('a moment on such a call carries the tag before anything plays, and stands off the strip', async () => {
    renderWorkspace({ legs: [beforeConsent, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    // Its call came before t = 0, so the tape stands at the start and names no moment.
    expect(clock()).toBe('00:00 / 00:45');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(tapeTag()).toHaveTextContent('Recorded before consent');
    // Its quote keeps its place in the order of the call, and has no tick or time to claim.
    expect(ticks()).toHaveLength(1);
    expect(chip(2).textContent).toBe('T8');
    expect(chip(2)).toHaveAccessibleName(/Play from here\.$/);
    fireEvent.click(tick(3));
    expect(tapeTag()).toBeNull();
    expect(clock()).toBe('00:16 / 00:45');
  });

  it('a consented call adds nothing to the tape', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    expect(tapeTag()).toBeNull();
  });

  it('carries the other tags unchanged too', async () => {
    renderWorkspace({ legs: [{ ...CALL_ONE, consent_stage: 'consent_withdrawn' }, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    expect(tapeTag()).toHaveTextContent('Consent withdrawn – recording kept');
  });
});

describe('a session read with no calls and no offsets (a worker session on the scoped Ashby page)', () => {
  const scoped = () => renderWorkspace({ session: bareRow(SESSION), legs: [], candidateId: undefined });

  it('prints every turn its time from its stamp, and none says it has no timing', async () => {
    scoped();
    const row = (await screen.findByText('What is your monthly target?')).closest<HTMLElement>('[data-turn-row]')!;
    expect(row.querySelector('[data-turn-time]')).toHaveTextContent('≈00:24');
    expect(within(row).getByRole('group')).toHaveAccessibleName(
      'Turn 5: Christy (AI). About 00:24 into the call. This turn cannot start playback.',
    );
    expect(screen.queryByText('no timing data')).toBeNull();
  });

  it('marks the moments as estimates, and the chips and quotes do not offer to play', async () => {
    scoped();
    await screen.findByText('What is your monthly target?');
    expect(chip(1)).toHaveTextContent('T6 · ≈00:29');
    expect(chip(1)).toHaveAccessibleName(/Go to this turn\.$/);
    expect(chip(1).querySelector('svg')).toBeNull();
    expect(document.querySelector('[data-consent-line]')).toHaveTextContent('Consent given at ≈00:19');
    // The line's own margin is an estimate too.
    expect(document.querySelector('[data-consent-line]')).toHaveTextContent(/^≈00:00T1–4/);
  });

  it('a press cues the moment and mints nothing, because that clock is on no file', async () => {
    scoped();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(chip(1));
    expect(clock()).toContain('00:29');
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Play from/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Turn 6:/ })).toBeNull();
  });
});

describe('a screen reader hears only what is true of a cue', () => {
  const noAudio = { state: 'unavailable' as const, reason: 'recording_failed' as const };

  it('a cue with no audio names the turn and the reason, and nothing says it plays', async () => {
    renderWorkspace({ legs: [{ ...CALL_ONE, recording: noAudio }, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(1));
    expect(
      await screen.findByText('Turn 6: Asha. Recording failed for this call, so its turns cannot start playback.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Now playing/)).toBeNull();
    expect(chip(1)).toHaveAccessibleName(/Go to this turn\.$/);
    expect(document.querySelector('[data-quote-button="1"]')).toHaveTextContent('Go to this turn');
    expect(document.querySelector('[data-quote-button="1"]')).not.toHaveTextContent('Play this moment');
  });

  it('a cue that plays still says so', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(3));
    expect(await screen.findByText('Now playing turn 10: Asha')).toBeInTheDocument();
    expect(chip(3)).toHaveAccessibleName(/Play from here\.$/);
    expect(document.querySelector('[data-quote-button="3"]')).toHaveTextContent('Play this moment');
  });
});

describe('Retry on the calls list', () => {
  const offsets = TRANSCRIPT.map((turn) => ({ ...turn, start_offset_sec: (turn.started_at_ms! - T0) / 1000 + 1 }));

  it('opens again on the calls, so Play reaches a file that is there', async () => {
    mockApi.getCandidatePhoneAttempts.mockRejectedValueOnce(new Error('nope'));
    renderWorkspace({ transcript: offsets });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(clock()).toContain('00:47');

    fireEvent.click(retry);
    await screen.findByRole('list', { name: 'Calls in this session' });
    await waitFor(() => expect(clock()).toContain('00:46'));
    fireEvent.click(screen.getByRole('button', { name: /^Play from/ }));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-1'));
    expect(mockRecordingApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
  });

  it('with nothing to cue it drops the old target, so Play uses its own start', async () => {
    mockApi.getCandidatePhoneAttempts.mockRejectedValueOnce(new Error('nope'));
    renderWorkspace({ card: null, transcript: offsets });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(turnButton(5));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());

    fireEvent.click(retry);
    await screen.findByRole('list', { name: 'Calls in this session' });
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-1'));
  });

  it('a Retry that fails again leaves the cue alone', async () => {
    mockApi.getCandidatePhoneAttempts.mockRejectedValue(new Error('nope'));
    render(<TranscriptionSyncWorkspace sessions={[SESSION]} assessments={[]} blocked={false} candidateId="c1" />);
    mockApi.getSession.mockResolvedValue({ session: bareRow(SESSION), transcript: offsets, assessment: assessment() });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockApi.getCandidatePhoneAttempts).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('a press and the panes', () => {
  it('pressing the cued quote again brings its row back, though the active turn did not change', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    expect(activeTurns()).toEqual(['8']);
    const writes = scrollWrites(pane('transcript'));
    fireEvent.click(tick(2));
    expect(activeTurns()).toEqual(['8']);
    expect(writes).toHaveLength(1);
    fireEvent.click(tick(2));
    expect(writes).toHaveLength(2);
  });

  it('a second quote in the same turn brings the row back too', async () => {
    const twice = [
      ...RESULTS.slice(0, 1),
      metricResult('m-objection', 'Objection handling', 2500, 2, ['the EMI option first', 'I tell them about']),
      ...RESULTS.slice(2),
    ];
    renderWorkspace({ card: assessment({ raw: { ...assessment().raw, metricResults: twice } as Assessment['raw'] }) });
    await screen.findByText('What is your monthly target?');
    const writes = scrollWrites(pane('transcript'));
    const inTurn = screen.getAllByRole('button', { name: /^Evidence \d, Objection handling/ });
    expect(inTurn).toHaveLength(2);
    fireEvent.click(inTurn[1]);
    expect(activeTurns()).toEqual(['8']);
    expect(writes).toHaveLength(1);
  });

  it('Play leaves the reasoning pane alone; only a press on a quote moves it', async () => {
    layout((el) => (el.matches('[data-quote-button]') ? 900 : null));
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    const writes = scrollWrites(pane('reasoning'));

    fireEvent.click(screen.getByRole('button', { name: /^Play from/ }));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    fireEvent.timeUpdate(document.querySelector('audio')!);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(writes).toEqual([]);

    fireEvent.click(chip(2));
    expect(writes).toHaveLength(1);
  });

  it('below 1180px a press also brings the row into the window, and playback never does', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    layout((el) => (el.matches('[data-turn-row]') ? 5000 : null));
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(chip(1));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());

    const audio = document.querySelector('audio')!;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 46, set: () => undefined });
    fireEvent.timeUpdate(audio);
    await waitFor(() => expect(activeTurns()).toEqual(['8']));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('leaves the window alone when the row is on screen', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(chip(1));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('a cue outranks the audio until it answers', () => {
  async function playCallOne() {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(1));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    const audio = document.querySelector('audio')!;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 40, set: () => undefined });
    fireEvent.play(audio);
    fireEvent.timeUpdate(audio);
    await waitFor(() => expect(clock()).toContain('00:40'));
    return audio;
  }

  it('the pause of the old call does not take the screen back', async () => {
    const callOne = await playCallOne();
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockReturnValue(new Promise(() => undefined));

    fireEvent.click(tick(3));
    expect(clock()).toContain('03:36');
    expect(activeTurns()).toEqual(['10']);

    // What a browser fires when the press pauses call one, while call two's link is still being minted.
    fireEvent.timeUpdate(callOne);
    fireEvent.pause(callOne);
    expect(clock()).toContain('03:36');
    expect(activeTurns()).toEqual(['10']);
    expect(tick(3)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Play from/ })).toHaveTextContent('Play from 03:36');
  });

  it('hands back to the audio once the cued call reports', async () => {
    const callOne = await playCallOne();
    fireEvent.click(tick(3));
    fireEvent.timeUpdate(callOne);
    await waitFor(() => expect(document.querySelectorAll('audio')).toHaveLength(2));
    const callTwo = document.querySelectorAll('audio')[1];
    Object.defineProperty(callTwo, 'currentTime', { configurable: true, get: () => 20, set: () => undefined });
    fireEvent.timeUpdate(callTwo);
    await waitFor(() => expect(clock()).toContain('03:40'));
  });

  it('stops waiting when the cued call fails, so the other call can be played again', async () => {
    const callOne = await playCallOne();
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockRejectedValue(new Error('nope'));
    fireEvent.click(tick(3));
    expect(await within(tapeStatus()).findByRole('alert')).toBeInTheDocument();
    fireEvent.timeUpdate(callOne);
    await waitFor(() => expect(clock()).toContain('00:40'));
  });
});

describe('the tape says what the recording is doing', () => {
  it('shows the loading word on the tape while the link is minted', async () => {
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockReturnValue(new Promise(() => undefined));
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    expect(tapeStatus()).toHaveTextContent('Recording loads on request; the link expires automatically.');
    fireEvent.click(screen.getByRole('button', { name: /^Play from/ }));
    expect(tapeStatus()).toHaveAttribute('data-tape-status', 'loading');
    expect(within(tapeStatus()).getByRole('status')).toHaveTextContent('Loading recording…');
  });

  it('says a failed mint in plain words beside Play, and Try again plays the moment asked for', async () => {
    const seeks: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: (sec: number) => seeks.push(sec),
    });
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockRejectedValueOnce(new Error('recording_not_found'));
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: /^Play from/ }));

    const failure = await within(tapeStatus()).findByRole('alert');
    expect(failure).not.toHaveTextContent('recording_not_found');
    fireEvent.click(within(tapeStatus()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(seeks).toContain(46));
    expect(tapeStatus()).toHaveAttribute('data-tape-status', 'ready');
  });

  it('a session with no recording reaches the same plain answer, not a dead end', async () => {
    mockRecordingApi.getRecordingDownloadUrl.mockRejectedValue(new Error('Recording not found'));
    renderWorkspace({ legs: [], candidateId: undefined, transcript: TRANSCRIPT.map((turn, at) => ({ ...turn, started_at_ms: null, start_offset_sec: at * 5 })) });
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: /^Play/ }));
    expect(await within(tapeStatus()).findByRole('alert')).toHaveTextContent('Recording not found');
  });

  it('offers Refresh link once the recording is loaded, and it mints a new one', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: /^Play from/ }));
    const refresh = await within(tapeStatus()).findByRole('button', { name: 'Refresh link' });
    expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(1);
    fireEvent.click(refresh);
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(2));
  });

  it('a Refresh that fails while playing leaves Play: there is no audio left to pause', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(1));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    fireEvent.play(document.querySelector('audio')!);
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();

    mockRecordingApi.getAttemptRecordingDownloadUrl.mockRejectedValue(new Error('recording_not_found'));
    fireEvent.click(within(tapeStatus()).getByRole('button', { name: 'Refresh link' }));
    expect(await within(tapeStatus()).findByRole('alert')).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Play from/ })).toBeInTheDocument();
  });

  it('says an expired link failed, beside Refresh link, because the audio cannot say why', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: /^Play from/ }));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    fireEvent.error(document.querySelector('audio')!);
    expect(await within(tapeStatus()).findByRole('alert')).toHaveTextContent('Failed to load recording');

    fireEvent.click(within(tapeStatus()).getByRole('button', { name: 'Refresh link' }));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(tapeStatus()).toHaveAttribute('data-tape-status', 'ready'));
    expect(within(tapeStatus()).queryByRole('alert')).toBeNull();
  });
});

describe('Play never names a moment it will not play', () => {
  const noAudio = { state: 'unavailable' as const, reason: 'recording_failed' as const };

  it('a cue on a call with no audio reads Play, says why, and plays what can be played', async () => {
    renderWorkspace({ legs: [{ ...CALL_ONE, recording: noAudio }, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    expect(clock()).toContain('00:46');
    expect(screen.queryByRole('button', { name: /^Play from/ })).toBeNull();
    const play = screen.getByRole('button', { name: 'Play' });
    expect(tapeStatus()).toHaveTextContent('Recording failed for this call, so its turns cannot start playback.');

    fireEvent.click(play);
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('leg-2'));
  });

  it('a cue that can play names its moment again', async () => {
    renderWorkspace({ legs: [{ ...CALL_ONE, recording: noAudio }, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(3));
    expect(screen.getByRole('button', { name: /^Play from/ })).toHaveTextContent('Play from 03:36');
  });

  it('pressing a silent moment stops the playing call rather than be carried back by it', async () => {
    renderWorkspace({ legs: [{ ...CALL_ONE, recording: noAudio }, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    fireEvent.click(tick(3));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    const audio = document.querySelector('audio')!;
    fireEvent.play(audio);

    fireEvent.click(tick(1));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 30, set: () => undefined });
    fireEvent.timeUpdate(audio);
    expect(clock()).toContain('00:30');
    expect(activeTurns()).toEqual([]);
    expect(tick(1)).toHaveAttribute('aria-pressed', 'true');
  });

  it('with nothing cued it says Play, not a start it may not have', async () => {
    renderWorkspace({ card: null });
    await screen.findByText('What is your monthly target?');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});

describe('the transcript as a log sheet', () => {
  it('names the speakers, and the AI as AI', async () => {
    renderWorkspace();
    const row = (await screen.findByText('What is your monthly target?')).closest<HTMLElement>('[data-turn-row]')!;
    expect(within(row).getByText('Christy (AI)')).toBeInTheDocument();
    const answer = screen.getByText(/My target is/).closest<HTMLElement>('[data-turn-row]')!;
    expect(within(answer).getByText('Asha')).toBeInTheDocument();
  });

  it('prints the timecode and the turn number in the margin', async () => {
    renderWorkspace();
    const row = (await screen.findByText('What is your monthly target?')).closest<HTMLElement>('[data-turn-row]')!;
    expect(within(row).getByText('T5')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Turn 5:/ })).toHaveTextContent('00:25');
  });

  it('puts cited words in a mark, and names the metric beside the number', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    const mark = document.querySelector('[data-evidence-mark="1"]')!;
    expect(mark.tagName).toBe('MARK');
    expect(mark).toHaveTextContent('My target is twelve a month');
    const row = mark.closest<HTMLElement>('[data-turn-row]')!;
    expect(within(row).getByText('Cited · Target clarity')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Evidence 1, Target clarity' })).toHaveTextContent('1');
  });

  it('marks the drop where the second call begins', async () => {
    renderWorkspace();
    const second = await screen.findByRole('group', { name: 'Call 2 of 2 · reconnect' });
    expect(within(second).getByText('Line dropped at 01:40; the call continued at 03:20')).toBeInTheDocument();
  });
});

describe('the consent line (Legal, 2026-11-05)', () => {
  it('folds the gate into the approved line, from the data', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    const row = document.querySelector<HTMLElement>('[data-consent-line]')!;
    expect(within(row).getByText('Consent given at 00:20')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Show 4 turns' })).toBeInTheDocument();
    expect(screen.queryByText('Yes, I consent.')).toBeNull();
    expect(row).toHaveTextContent('T1–4');
  });

  it('opens to the full turns in one press, every word, and hands focus to the first of them', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 turns' }));
    for (const turn of TRANSCRIPT.slice(0, 4)) expect(screen.getByText(turn.text)).toBeInTheDocument();
    expect(document.querySelector('[data-consent-line]')).toBeNull();
    expect(turnButton(1)).toHaveFocus();
  });

  it('with no audio on the call there is no button to hand focus to, so the first row takes it', async () => {
    const noAudio = { state: 'unavailable' as const, reason: 'recording_failed' as const };
    renderWorkspace({ legs: [{ ...CALL_ONE, recording: noAudio }, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 turns' }));
    const first = document.querySelector<HTMLElement>('[data-turn-row="1"]')!;
    expect(first.querySelector('button')).toBeNull();
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('tabindex', '-1');
  });

  it('claims nothing on a call that ended at the gate: the turns stay in full', async () => {
    renderWorkspace({ transcript: TRANSCRIPT.slice(0, 4), card: null, legs: [CALL_ONE] });
    expect(await screen.findByText('Yes, I consent.')).toBeInTheDocument();
    expect(screen.queryByText(/Consent given/)).toBeNull();
    expect(screen.getByRole('img')).not.toHaveAccessibleName(/Consent given/);
  });

  it('claims nothing on a call recorded before consent', async () => {
    renderWorkspace({ legs: [{ ...CALL_ONE, consent_stage: 'before_consent' }, CALL_TWO] });
    expect(await screen.findByText('Yes, I consent.')).toBeInTheDocument();
    expect(screen.queryByText(/Consent given/)).toBeNull();
  });

  it('keeps the recording consent tags word for word', async () => {
    renderWorkspace({ legs: [{ ...CALL_ONE, consent_stage: 'consent_withdrawn' }, CALL_TWO] });
    await screen.findByText('What is your monthly target?');
    expect(document.querySelector('[data-leg-consent]')).toHaveTextContent('Consent withdrawn – recording kept');
  });
});

describe('the reasoning pane', () => {
  it('leads with the AI recommendation, labelled as AI, in a pencilled box while provisional', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'AI recommendation' });
    expect(screen.getByText('AI scoring of this call. Not a hiring decision.')).toBeInTheDocument();
    const box = document.querySelector<HTMLElement>('[data-verdict-box]')!;
    expect(box).toHaveAttribute('data-verdict-box', 'provisional');
    expect(box.className).toContain('border-dashed');
    expect(box).toHaveTextContent('Provisional · 3 of 4 metrics');
    expect(within(box).getByText('Select')).toBeInTheDocument();
    expect(within(box).getByText('67')).toBeInTheDocument();
  });

  it.each([
    ['advance', 'full', 'Select'],
    ['hold', 'half', 'Borderline'],
    ['reject', 'empty', 'Reject'],
  ])('draws %s as a %s circle beside its word, keeping the shape', async (recommendation, shape, word) => {
    renderWorkspace({
      card: assessment({
        recommendation: recommendation as Assessment['recommendation'],
        raw: { ...assessment().raw, recommendation } as Assessment['raw'],
      }),
    });
    await screen.findByRole('heading', { name: 'AI recommendation' });
    const mark = document.querySelector<SVGElement>(`[data-verdict-mark="${shape}"]`)!;
    expect(mark).not.toBeNull();
    expect(mark.parentElement).toHaveTextContent(word);
    expect(mark.innerHTML).not.toMatch(/var\(/);
  });

  describe('takes its colour from the verdict and the ratings', () => {
    /** The same row with its verdict, figure and rubric swapped, firm unless it says otherwise. */
    function scored({
      recommendation = 'advance',
      overall = 67,
      status = 'complete',
      results = RESULTS.map((r) => (r.score === null ? metricResult('m-closing', 'Closing', 2500, 3, []) : r)),
      scale = 4,
      redFlags = [],
      held = false,
    }: {
      recommendation?: string | null;
      overall?: number | null;
      status?: 'complete' | 'incomplete_evidence';
      results?: ReturnType<typeof metricResult>[];
      scale?: number;
      redFlags?: string[];
      held?: boolean;
    }): Assessment {
      return assessment({
        recommendation: recommendation as Assessment['recommendation'],
        overall_score: overall as number,
        scoring_status: status,
        ...(held ? { evidence_grade: 'insufficient' as const, evidence_reason: 'partial_thin' as const } : {}),
        role_fit: { score: 0, matched_skills: [], gaps: [], red_flags: redFlags, notes: '' },
        raw: {
          ...assessment().raw,
          recommendation,
          overallScore: overall,
          status,
          scoreScaleMax: scale,
          metricResults: results,
        } as Assessment['raw'],
      });
    }

    const verdictBox = () => document.querySelector<HTMLElement>('[data-verdict-box]')!;
    const ruler = () => document.querySelector<HTMLElement>('[data-score-ruler]')!;
    const zone = (family: string) => document.querySelector<HTMLElement>(`[data-ruler-zone="${family}"]`)!;
    const rubricRows = () => [...document.querySelectorAll<HTMLElement>('[data-rubric-row]')];

    it.each([
      ['advance', 'bg-ready-soft', 'border-ready', 'text-ready-text'],
      ['hold', 'bg-unresolved-soft', 'border-unresolved', 'text-unresolved-text'],
      ['reject', 'bg-closed-soft', 'border-closed', 'text-closed-text'],
    ])('a firm %s is a %s block with a solid %s edge, and its figure is %s', async (recommendation, wash, edge, text) => {
      renderWorkspace({ card: scored({ recommendation }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      const box = verdictBox();
      expect(box).toHaveAttribute('data-verdict-box', 'firm');
      expect(box).toHaveClass(wash, edge, 'border');
      expect(box.className).not.toMatch(/border-dashed|border-[lrtbxy]-|border-rule/);
      expect(within(box).getByText('67')).toHaveClass(text);
      expect(within(box).getByText('/100')).toHaveClass('text-ink-tertiary');
    });

    it.each([
      ['advance', 'bg-ready-soft', 'border-ready'],
      ['hold', 'bg-unresolved-soft', 'border-unresolved'],
      ['reject', 'bg-closed-soft', 'border-closed'],
    ])('a provisional %s keeps its family, and its edge is dashed', async (recommendation, wash, edge) => {
      renderWorkspace({ card: scored({ recommendation, status: 'incomplete_evidence', results: RESULTS }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expect(verdictBox()).toHaveAttribute('data-verdict-box', 'provisional');
      expect(verdictBox()).toHaveClass(wash, edge, 'border-dashed');
    });

    it('says "Provisional" in the unresolved family, on the stamp and in the paragraph, on any verdict', async () => {
      renderWorkspace({ card: scored({ recommendation: 'advance', status: 'incomplete_evidence', results: RESULTS }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expect(within(verdictBox()).getByText('Provisional')).toHaveClass('text-unresolved-text');
      expect(screen.getByText('Provisional:')).toHaveClass('text-unresolved-text');
    });

    it.each([
      ['no recommendation', null, 67],
      ['needs human review', 'human_review', 67],
      ['no figure and no recommendation', null, null],
    ])('gives a block with %s no hue', async (_case, recommendation, overall) => {
      renderWorkspace({ card: scored({ recommendation, overall }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      const box = verdictBox();
      expect(box.className).not.toMatch(/ready|unresolved|closed/);
      expect(box).toHaveClass('border-rule-2');
    });

    /** The whole ruler has no hue and emphasises nothing: its zones are grey, its labels quiet. */
    const expectNoHueRuler = () => {
      for (const family of ['closed', 'unresolved', 'ready']) {
        expect(zone(family)).toHaveClass('bg-rule-2', 'data-fill');
        expect(zone(family).className).not.toMatch(/bg-(ready|unresolved|closed)/);
      }
      expect(document.querySelector('[data-ruler-zone][data-current]')).toBeNull();
      for (const word of ['Reject', 'Borderline 45', 'Select 65']) {
        const label = within(ruler()).getByText(word);
        expect(label).toHaveClass('text-ink-tertiary');
        expect(label.className).not.toMatch(/ready|unresolved|closed|font-semibold/);
      }
    };

    it('prints "Not scored" with no hue, in the ruler as well', async () => {
      renderWorkspace({ card: scored({ recommendation: null, overall: null }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      for (const word of within(verdictBox()).getAllByText('Not scored')) {
        expect(word.className).not.toMatch(/ready|unresolved|closed/);
      }
      expectNoHueRuler();
      expect(ruler().querySelector('[data-score-mark]')).toBeNull();
      expect(ruler().querySelectorAll('[data-score-cut]')).toHaveLength(2);
    });

    it.each([
      [0, 'reject', 'closed'],
      [44, 'reject', 'closed'],
      [45, 'hold', 'unresolved'],
      [64, 'hold', 'unresolved'],
      [65, 'advance', 'ready'],
      [100, 'advance', 'ready'],
    ])('at %s, a stored %s paints the %s zone in its mark and the other two in their light step', async (overall, recommendation, current) => {
      renderWorkspace({ card: scored({ overall, recommendation }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      for (const family of ['closed', 'unresolved', 'ready']) {
        expect(zone(family)).toHaveClass(family === current ? `bg-${family}` : `bg-${family}-light`);
        expect(zone(family)).toHaveClass('data-fill');
      }
      expect(document.querySelector('[data-ruler-zone][data-current]')).toBe(zone(current));
      expect(ruler().querySelector('[data-score-mark]')).toHaveStyle({ left: `${overall}%` });
    });

    it('never says Select beside a Reject: the stored verdict decides, and the mark stays at the raw score', async () => {
      renderWorkspace({ card: scored({ recommendation: 'reject', overall: 72 }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expect(verdictBox()).toHaveClass('bg-closed-soft', 'border-closed');
      expect(zone('closed')).toHaveClass('bg-closed');
      expect(document.querySelector('[data-ruler-zone][data-current]')).toBe(zone('closed'));
      expect(zone('ready')).toHaveClass('bg-ready-light');
      expect(within(ruler()).getByText('Reject')).toHaveClass('text-closed-text', 'font-semibold');
      expect(within(ruler()).getByText('Select 65')).not.toHaveClass('font-semibold');
      expect(ruler().querySelector('[data-score-mark]')).toHaveStyle({ left: '72%' });
    });

    it('gives a score with no verdict of its own no hue and no emphasis, with the mark at the score', async () => {
      renderWorkspace({ card: scored({ recommendation: 'human_review', overall: 67 }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expectNoHueRuler();
      expect(ruler().querySelector('[data-score-mark]')).toHaveStyle({ left: '67%' });
    });

    describe('a scorecard held for thin evidence has no hue, and its words do not change', () => {
      it.each([
        ['advance', 'Select'],
        ['hold', 'Borderline'],
        ['reject', 'Reject'],
      ])('a held %s: no wash, a plain edge, an ink figure, an ink circle and a grey ruler', async (recommendation, word) => {
        renderWorkspace({ card: scored({ recommendation, overall: 80, held: true }) });
        await screen.findByRole('heading', { name: 'AI recommendation' });
        expect(screen.getByText('Not enough interview evidence to decide')).toBeInTheDocument();
        const box = verdictBox();
        expect(box).toHaveAttribute('data-verdict-box', 'firm');
        expect(box).toHaveClass('border-rule-2');
        expect(box.className).not.toMatch(/bg-|ready|unresolved|closed/);
        expect(within(box).getByText('80')).toHaveClass('text-ink');
        const verdict = box.querySelector('[data-recommendation]')!;
        expect(verdict).toHaveClass('text-ink');
        expect(verdict).toHaveTextContent(word);
        expect(box.querySelector('[data-verdict-mark]')).toHaveClass('text-ink');
        expectNoHueRuler();
        expect(ruler().querySelector('[data-score-mark]')).toHaveStyle({ left: '80%' });
      });

      it('keeps the shape of the verdict and the dashes of a provisional one', async () => {
        renderWorkspace({
          card: scored({ recommendation: 'advance', overall: 80, held: true, status: 'incomplete_evidence', results: RESULTS }),
        });
        await screen.findByRole('heading', { name: 'AI recommendation' });
        expect(verdictBox()).toHaveAttribute('data-verdict-box', 'provisional');
        expect(verdictBox()).toHaveClass('border-dashed', 'border-ink-secondary');
        expect(verdictBox().className).not.toMatch(/ready|bg-/);
        expect(verdictBox().querySelector('[data-verdict-mark]')).toHaveAttribute('data-verdict-mark', 'full');
      });

      it('gives its ratings and its evidence numbers no hue either, on the rubric and on the strip', async () => {
        renderWorkspace({ card: scored({ recommendation: 'advance', overall: 80, held: true }) });
        await screen.findByRole('heading', { name: 'AI recommendation' });
        for (const row of rubricRows()) {
          for (const pip of row.querySelectorAll('[data-rating-pips] > .data-fill')) {
            expect(pip).toHaveClass('bg-ink', 'border-ink');
          }
          expect(row.innerHTML).not.toMatch(/(?:bg|text|border)-(?:ready|unresolved|closed)/);
        }
        expect(ticks().length).toBeGreaterThan(0);
        for (const strip of ticks()) expect(strip.getAttribute('class') ?? '').not.toMatch(/ready|unresolved|closed/);
      });

      it('reaches the fallback card too, the one Review prints when it cannot use the rubric pane', async () => {
        // No completed screening to open, so the rubric pane has no session and the latest scorecard takes the card.
        const unfinished: Session = { ...SESSION, status: 'failed' };
        renderWorkspace({ session: unfinished, legs: [], card: scored({ recommendation: 'advance', overall: 80, held: true }) });
        const card = await screen.findByRole('region', { name: 'Overall assessment' });
        expect(document.querySelector('[data-verdict-box]')).toBeNull();
        expect(within(card).getByText('80')).toHaveClass('text-ink');
        expect(card.querySelector('[data-recommendation="advance"]')).toHaveClass('text-ink');
        expect(card.innerHTML).not.toMatch(/(?:bg|text)-(?:ready|unresolved|closed)/);
      });

      // Review no longer opens an R1 session (#413), so an R1 row is read on the shared scorecard view.
      describe('on the scorecard view, for an R1 row', () => {
        /** As the scorer stores one: the column NULL, raw keeping the truth. */
        const r1Row = (recommendation: string | null, stored: string, valid: boolean) => {
          const row = scored({ recommendation, overall: 80, results: [metricResult('m-a', 'Rapport', 5000, 4, []), metricResult('m-b', 'Closing', 5000, 2, [])] });
          return { ...row, raw: { ...row.raw, recommendation: stored, r1: { outcome: 'scored', valid, gate: { passed: valid, failures: [] } } } } as unknown as Assessment;
        };

        it('prints the ratings of a failed gate in ink, the words and figures unchanged', () => {
          const { container: card } = render(<RoleScorecardView assessment={r1Row(null, 'human_review', false)} />);
          expect(card.querySelector('[data-recommendation="human_review"]')).toHaveClass('text-ink');
          expect(within(card).getByText('Needs human review')).toBeInTheDocument();
          expect(within(card).getByText('Excellent')).toHaveClass('text-ink');
          expect(within(card).getByText('Average')).toHaveClass('text-ink');
          expect(within(card).getByText('2/4')).toBeInTheDocument();
          expect(card.innerHTML).not.toMatch(/(?:bg|text)-(?:ready|closed)/);
          expect(screen.queryByText('Not enough interview evidence to decide')).toBeNull();
        });

        it('keeps a valid R1 row in colour', () => {
          const { container: card } = render(<RoleScorecardView assessment={r1Row('advance', 'advance', true)} />);
          expect(within(card).getByText('Excellent')).toHaveClass('text-ready-text');
          expect(within(card).getByText('Average')).toHaveClass('text-unresolved-text');
        });
      });

      it('leaves the same row in colour when it is not held', async () => {
        renderWorkspace({ card: scored({ recommendation: 'advance', overall: 80 }) });
        await screen.findByRole('heading', { name: 'AI recommendation' });
        expect(verdictBox()).toHaveClass('bg-ready-soft', 'border-ready');
        expect(zone('ready')).toHaveClass('bg-ready');
      });
    });

    it('lays the zones out Reject, Borderline, Select, each as wide as its cut-offs say', async () => {
      renderWorkspace({ card: scored({ overall: 67 }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      const zones = [...document.querySelectorAll<HTMLElement>('[data-ruler-zone]')];
      expect(zones.map((el) => el.getAttribute('data-ruler-zone'))).toEqual(['closed', 'unresolved', 'ready']);
      expect(zones.map((el) => el.style.width)).toEqual(['45%', '20%', '35%']);
    });

    it('prints each label in its own family, the current one heavier, and the 100 quiet', async () => {
      renderWorkspace({ card: scored({ overall: 50, recommendation: 'hold' }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      const on = within(ruler());
      expect(on.getByText('Reject')).toHaveClass('text-closed-text');
      expect(on.getByText('Reject')).not.toHaveClass('font-semibold');
      expect(on.getByText('Borderline 45')).toHaveClass('text-unresolved-text', 'font-semibold');
      expect(on.getByText('Select 65')).toHaveClass('text-ready-text');
      expect(on.getByText('Select 65')).not.toHaveClass('font-semibold');
      // It takes the row's own quiet ink.
      expect(on.getByText('100').className).not.toMatch(/ready|unresolved|closed/);
      expect(on.getByText('100').parentElement).toHaveClass('text-ink-tertiary');
    });

    it('sets Borderline and Select back to back on the Select tick, so they cannot run together on a phone', async () => {
      renderWorkspace({ card: scored({ overall: 50, recommendation: 'hold' }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      const on = within(ruler());
      expect(on.getByText('Borderline 45')).toHaveStyle({ left: '65%' });
      expect(on.getByText('Borderline 45')).toHaveClass('-translate-x-full', 'pr-1');
      expect(on.getByText('Select 65')).toHaveStyle({ left: '65%' });
      expect(on.getByText('Select 65')).toHaveClass('pl-1');
    });

    it('keeps the score mark and the cut-off ticks as they were, so they read across any zone', async () => {
      renderWorkspace({ card: scored({ overall: 67 }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expect(ruler().querySelector('[data-score-mark]')).toHaveClass('bg-ink', 'data-fill');
      expect(ruler().querySelector('[data-score-mark]')).toHaveStyle({ left: '67%' });
      expect(ruler().querySelectorAll('[data-score-cut]')).toHaveLength(2);
    });

    it('says what to check before deciding in the unresolved family, never crimson', async () => {
      renderWorkspace({
        card: scored({ status: 'incomplete_evidence', results: RESULTS, redFlags: ['Ended the call early'] }),
      });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      // The role fit panel prints "Red flag:" as a screen reader prefix on its chips too.
      const lead = screen.getAllByText('Red flag:').find((el) => el.closest('li')?.querySelector('svg'))!;
      const missing = screen.getByText('Closing: insufficient evidence.');
      expect(lead).toHaveClass('text-unresolved-text');
      expect(missing).toHaveClass('text-unresolved-text');
      expect(lead.closest('li')!.querySelector('svg')).toHaveClass('text-unresolved-text');
      expect(missing.closest('li')!.querySelector('svg')).toHaveClass('text-unresolved-text');
      expect(lead.closest('ul')!.innerHTML).not.toMatch(/danger|error/);
    });

    it('keeps "Red flags: none identified" quiet', async () => {
      renderWorkspace({ card: scored({}) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expect(screen.getByText('Red flags: none identified')).toHaveClass('text-ink-tertiary');
    });

    it.each([
      [4, 4, 'ready'],
      [3, 4, 'ready'],
      [2, 4, 'unresolved'],
      [1, 4, 'closed'],
      [5, 5, 'ready'],
      [4, 5, 'ready'],
      [3, 5, 'unresolved'],
      [2, 5, 'closed'],
      [1, 5, 'closed'],
    ])('rates %s of %s in the %s family: pips, word and figure, the name and weight unchanged', async (score, scale, family) => {
      renderWorkspace({
        card: scored({ scale, results: [metricResult('m-target', 'Target clarity', 10000, score, ['My target is twelve a month'])] }),
      });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      const [row] = rubricRows();
      const pips = [...row.querySelectorAll<HTMLElement>('[data-rating-pips] > span')];
      expect(pips).toHaveLength(scale);
      pips.slice(0, score).forEach((pip) => expect(pip).toHaveClass(`bg-${family}`, `border-${family}`, 'data-fill'));
      pips.slice(score).forEach((pip) => {
        expect(pip).toHaveClass('border-control');
        expect(pip.className).not.toMatch(/data-fill|bg-/);
      });
      expect(within(row).getByText(new RegExp(`, ${score}/${scale}$`)).parentElement).toHaveClass(`text-${family}-text`);
      expect(within(row).getByRole('heading', { level: 4 })).toHaveClass('text-ink');
      expect(within(row).getByText('100%')).toHaveClass('text-ink-tertiary');
    });

    it('says Insufficient evidence in the unresolved family, with a dashed edge, and prints no pips', async () => {
      renderWorkspace({ card: scored({ status: 'incomplete_evidence', results: RESULTS }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      const row = rubricRows()[3];
      const pill = within(row).getByText('Insufficient evidence');
      expect(pill).toHaveClass('text-unresolved-text', 'border-unresolved', 'border-dashed');
      expect(row.querySelector('[data-rating-pips]')).toBeNull();
    });

    it('keeps a pressed seek chip in ink: ink is selection', async () => {
      renderWorkspace({ card: scored({}) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      fireEvent.click(chip(1));
      await waitFor(() => expect(chip(1)).toHaveAttribute('aria-pressed', 'true'));
      expect(chip(1)).toHaveClass('bg-ink', 'text-paper', 'border-ink');
    });

    it('changes no word: the block reads as it always did', async () => {
      renderWorkspace({ card: scored({ recommendation: 'hold', overall: 58 }) });
      await screen.findByRole('heading', { name: 'AI recommendation' });
      expect(verdictBox()).toHaveTextContent('Borderline58/100RejectBorderline 45Select 65100');
    });
  });

  it('says the verdict in one sentence built from the figures', async () => {
    renderWorkspace();
    expect(
      await screen.findByText(
        '67 of 100, 2 above the Select cut-off. 1 of the 3 scored metrics is Excellent; the weakest is Objection handling (Average, 25% of the weight).',
      ),
    ).toBeInTheDocument();
  });

  it('a score on the cut-off is at it, never "0 above" it', async () => {
    renderWorkspace({ card: assessment({ overall_score: 65, raw: { ...assessment().raw, overallScore: 65 } as Assessment['raw'] }) });
    expect(await screen.findByText(/^65 of 100, at the Select cut-off\. /)).toBeInTheDocument();
    expect(screen.queryByText(/above the Select/)).toBeNull();
  });

  it('prints the what-if line in the form Legal approved, as text, computed from the row', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'AI recommendation' });
    const line = document.querySelector<HTMLElement>('[data-what-if]')!;
    // Scored 25%*4 + 25%*2 + 25%*3 = 2.25. At 1: 2.5 -> 50. At 4: 3.25 -> 75. At 2: 2.75 -> 58.
    expect(line.textContent).toBe('Once Closing is scored it would read 50 to 75; at Average, 58 (Borderline)');
    expect(line.querySelector('*')).toBeNull();
  });

  it('shows no what-if line when every metric is scored', async () => {
    const complete = RESULTS.map((r) => (r.score === null ? metricResult('m-closing', 'Closing', 2500, 3, []) : r));
    renderWorkspace({
      card: assessment({
        scoring_status: 'complete',
        raw: { ...assessment().raw, status: 'complete', metricResults: complete } as Assessment['raw'],
      }),
    });
    await screen.findByRole('heading', { name: 'AI recommendation' });
    expect(document.querySelector('[data-what-if]')).toBeNull();
    expect(document.querySelector('[data-verdict-box]')).toHaveAttribute('data-verdict-box', 'firm');
  });

  it('shows every rubric row on arrival, each with its seek chip, the unscored one in pencil', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'AI recommendation' });
    const rows = [...document.querySelectorAll<HTMLElement>('[data-rubric-row]')];
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByRole('button', { name: /^T6 · 00:30/ })).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: /^T8 · 00:46/ })).toBeInTheDocument();
    expect(within(rows[2]).getByRole('button', { name: /^T10 · 03:36/ })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Excellent, 4/4');
    const pencil = within(rows[3]).getByText('Insufficient evidence');
    expect(pencil.className).toContain('border-dashed');
    expect(rows[3]).toHaveTextContent('not counted');
  });

  it('widens the chip column on every row once a timecode has hours, so the columns still line up', async () => {
    const columns = () => [...document.querySelectorAll('[data-rubric-row]')].map((row) => row.firstElementChild!.className);
    const { unmount } = renderWorkspace();
    await screen.findByRole('heading', { name: 'AI recommendation' });
    expect(new Set(columns()).size).toBe(1);
    expect(columns()[0]).toContain('_6.75rem_');
    unmount();

    renderWorkspace({
      legs: [CALL_ONE, nextDay(CALL_TWO)],
      transcript: TRANSCRIPT.map((turn, at) => (at < 8 ? turn : { ...turn, started_at_ms: turn.started_at_ms! + DAY })),
    });
    await screen.findByRole('heading', { name: 'AI recommendation' });
    expect(chip(3)).toHaveTextContent('T10 · 24:03:36');
    expect(new Set(columns()).size).toBe(1);
    expect(columns()[0]).toContain('_8.75rem_');
  });

  it('opens the quote buttons on the weakest metric only', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'AI recommendation' });
    const rows = [...document.querySelectorAll<HTMLElement>('[data-rubric-row]')];
    expect(within(rows[1]).getByRole('button', { name: /the EMI option first/ })).toBeInTheDocument();
    expect(rows[0].querySelector('[data-quote-button]')).toBeNull();
    expect(rows[2].querySelector('[data-quote-button]')).toBeNull();
  });

  it('shows a quote that was cut short as cut, in its row and in its button', async () => {
    const cut = [
      RESULTS[0],
      metricResult('m-objection', 'Objection handling', 2500, 2, ['the EMI opt…', 'words that were never sa…']),
      ...RESULTS.slice(2),
    ];
    renderWorkspace({ card: assessment({ raw: { ...assessment().raw, metricResults: cut } as Assessment['raw'] }) });
    await screen.findByRole('heading', { name: 'AI recommendation' });
    expect(screen.getByRole('button', { name: /the EMI opt…/ })).toBeInTheDocument();
    expect(screen.getByText('“words that were never sa…”')).toBeInTheDocument();
  });

  it('keeps a quote it could not place readable as text, with no number, position or apology', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'AI recommendation' });
    const words = screen.getByText('“words that were never said”');
    expect(words.closest('button')).toBeNull();
    expect(words.tagName).toBe('P');
    expect(screen.queryByText(/not found/i)).toBeNull();
    expect(ticks()).toHaveLength(3);
  });

  it('says none identified only when the row carries the list', async () => {
    const { unmount } = renderWorkspace();
    expect(await screen.findByText('Red flags: none identified')).toBeInTheDocument();
    unmount();

    renderWorkspace({ card: assessment({ role_fit: undefined }) });
    await screen.findByRole('heading', { name: 'AI recommendation' });
    expect(screen.queryByText('Red flags: none identified')).toBeNull();
  });

  it('lists a red flag as the AI said it, its lead word unresolved and the flag in the ink of the list', async () => {
    renderWorkspace({
      card: assessment({ role_fit: { score: 0, matched_skills: [], gaps: [], red_flags: ['Vague on numbers'], notes: '' } }),
    });
    const check = (await screen.findByRole('heading', { name: 'Check before deciding' })).parentElement!.parentElement!;
    expect(check).toHaveTextContent('Red flag: Vague on numbers');
    expect(within(check).getByText('Red flag:')).toHaveClass('text-unresolved-text');
    expect(within(check).getByText('Red flag:').parentElement!.className).not.toMatch(/ready|unresolved|closed/);
    expect(screen.queryByText('Red flags: none identified')).toBeNull();
  });

  it('says what the resume says, and only what it has', async () => {
    renderWorkspace({ resumeFacts: { current_role: 'Admissions counsellor', recent_role: { title: 'Team lead', employer: 'Example Ltd' } } });
    await screen.findByRole('heading', { name: 'AI recommendation' });
    expect(screen.getByRole('heading', { name: 'From the resume' })).toBeInTheDocument();
    expect(screen.getByText('Admissions counsellor')).toBeInTheDocument();
    expect(screen.getByText('Team lead, Example Ltd')).toBeInTheDocument();
    expect(screen.queryByText('Education')).toBeNull();
  });

  it('carries the drop into Check before deciding', async () => {
    renderWorkspace();
    const check = (await screen.findByRole('heading', { name: 'Check before deciding' })).parentElement!.parentElement!;
    expect(check).toHaveTextContent('Line dropped at 01:40; the call continued at 03:20');
    expect(check).toHaveTextContent('Closing: insufficient evidence.');
  });
});

describe('the states', () => {
  it('holds its final size while loading: the log header, the strip space and both panes are there', async () => {
    mockApi.getSession.mockReturnValue(new Promise(() => undefined));
    mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [], next_cursor: null });
    render(<TranscriptionSyncWorkspace sessions={[SESSION]} assessments={[]} blocked={false} candidateId="c1" />);
    expect(document.querySelector('[data-log-header]')).not.toBeNull();
    expect(document.querySelector('[data-tape-placeholder]')).not.toBeNull();
    expect(await screen.findByRole('status', { name: 'Loading transcript' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading the scorecard' })).toBeInTheDocument();
  });

  it('says a failed transcript in plain words with Retry, and keeps the scorecard it can show', async () => {
    const card = assessment();
    mockApi.getSession.mockRejectedValueOnce({ message: 'upstream_timeout_504' });
    mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [], next_cursor: null });
    render(<TranscriptionSyncWorkspace sessions={[SESSION]} assessments={[card]} blocked={false} candidateId="c1" />);
    expect(await screen.findByText('The transcript could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('upstream_timeout_504')).toBeNull();
    expect(screen.getByRole('heading', { name: 'AI recommendation' })).toBeInTheDocument();
    // No transcript, so no quote has a place.
    expect(document.querySelector('[data-seek-chip]')).toBeNull();
    expect(document.querySelector('[data-call-strip]')).toBeNull();

    mockApi.getSession.mockResolvedValue({ session: SESSION, transcript: TRANSCRIPT, assessment: card });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('What is your monthly target?')).toBeInTheDocument();
  });

  it('with no recording the strip stays, says why, and offers nothing to play', async () => {
    const lost = { state: 'unavailable' as const, reason: 'recording_failed' as const };
    renderWorkspace({ legs: [{ ...CALL_ONE, recording: lost }, { ...CALL_TWO, recording: lost }] });
    await screen.findByText('What is your monthly target?');
    expect(document.querySelector('[data-call-strip]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Play from/ })).toBeNull();
    expect(screen.getAllByText('Recording unavailable (capture failed)').length).toBeGreaterThanOrEqual(1);
  });

  it('while decision use is blocked no verdict, quote or tick is shown', async () => {
    renderWorkspace({ blocked: true });
    await screen.findByText('What is your monthly target?');
    expect(screen.getByText('Scorecards are suppressed while an appeal is under review.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'AI recommendation' })).toBeNull();
    expect(ticks()).toHaveLength(0);
    expect(document.querySelector('mark')).toBeNull();
    expect(screen.queryByText(/^Cited/)).toBeNull();
  });

  it('a viewer without transcript access gets the note and the latest scorecard, with quotes as text', async () => {
    const card = assessment();
    mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(<TranscriptionSyncWorkspace sessions={[SESSION]} assessments={[card]} blocked={false} />);
    expect(await screen.findByText(/require admin access/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI recommendation' })).toBeInTheDocument();
    expect(document.querySelector('[data-call-strip]')).toBeNull();
    expect(document.querySelector('[data-seek-chip]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Objection handling' }));
    expect(screen.getByText('“the EMI option first”')).toBeInTheDocument();
  });

  describe('a viewer whose scorecard is another call\'s', () => {
    const newer: Session = { ...SESSION, id: 'session-2', created_at: '2026-10-07T03:30:00.000Z' };
    const denied = () => mockApi.getSession.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));

    it('never says it scored this call', async () => {
      denied();
      mockApi.getCandidatePhoneAttempts.mockResolvedValue({ attempts: [CALL_ONE, CALL_TWO], next_cursor: null });
      render(
        <TranscriptionSyncWorkspace
          sessions={[SESSION, newer]}
          assessments={[assessment({ session_id: 'session-2' })]}
          blocked={false}
          candidateId="c1"
        />,
      );
      expect(await screen.findByRole('heading', { name: 'Latest scorecard' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'AI recommendation' })).toBeNull();
      expect(screen.queryByText(/of this call/)).toBeNull();
      expect(screen.getByText('AI scoring. Not a hiring decision.')).toBeInTheDocument();
      expect(screen.getByText(/The latest scorecard is shown alongside\./)).toBeInTheDocument();
      expect(screen.queryByText(/The session scorecard is shown alongside/)).toBeNull();
      // Its own findings stay; this session's drop is not one of them.
      await waitFor(() => expect(mockApi.getCandidatePhoneAttempts).toHaveBeenCalled());
      expect(screen.queryByText(/^Line dropped/)).toBeNull();
    });

    it('keeps the wording when the row is the selected call\'s own', async () => {
      denied();
      render(
        <TranscriptionSyncWorkspace sessions={[SESSION]} assessments={[assessment()]} blocked={false} />,
      );
      expect(await screen.findByRole('heading', { name: 'AI recommendation' })).toBeInTheDocument();
      expect(screen.getByText('AI scoring of this call. Not a hiring decision.')).toBeInTheDocument();
      expect(screen.getByText(/The session scorecard is shown alongside\./)).toBeInTheDocument();
    });
  });

  it('a legacy assessment keeps its own card', async () => {
    renderWorkspace({
      card: {
        id: 'a-old',
        overall_score: 78,
        recommendation: 'advance',
        summary: 'Solid.',
        tone: { clarity: 8, confidence: 7, professionalism: 9, sentiment: 'positive', notes: '' },
        role_fit: { score: 8, matched_skills: [], gaps: [], red_flags: [], notes: '' },
        raw: null,
      } as Assessment,
    });
    expect(await screen.findByText('Scorecard for this session')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'AI recommendation' })).toBeNull();
    expect(ticks()).toHaveLength(0);
  });
});

describe('the panes', () => {
  it('has a skip link into each pane, and each pane can take focus', async () => {
    renderWorkspace();
    await screen.findByText('What is your monthly target?');
    const transcript = screen.getByRole('link', { name: 'Skip to transcript' });
    const reasoning = screen.getByRole('link', { name: 'Skip to AI recommendation' });
    expect(document.querySelector(transcript.getAttribute('href')!)).toHaveAttribute('tabindex', '0');
    expect(document.querySelector(reasoning.getAttribute('href')!)).toHaveAttribute('tabindex', '0');
  });

  it('has no axe violations with the strip, the transcript and the scorecard on screen', async () => {
    const { container } = renderWorkspace();
    await screen.findByText('What is your monthly target?');
    await expect(container).toHaveNoViolations();
  });
});
