/**
 * SessionLegRow (M013 S02) — the Review tab's leg row states recording facts
 * only for a recording that can be played, exactly as the Overview list does
 * (review, S02): a deleted or withdrawn leg never reads "Recorded ≈53s" or
 * "may end a few seconds before the call did" next to "Recording deleted".
 * Synthetic timings only.
 */
import { createRef } from 'react';
import type { Ref } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { CandidatePhoneAttempt } from '../../../types';
import { SessionLegRow } from '../SessionLegRow';
import type { SessionLegRowProps } from '../SessionLegRow';
import type { RecordingPlayerHandle } from '../RecordingPlayer';
import { LEG_TAIL_NOTE } from '../sessionLegs';

const mockRecordingApi = { getAttemptRecordingDownloadUrl: vi.fn(), getRecordingDownloadUrl: vi.fn() };

vi.mock('../../../api', () => ({
  api: {
    getAttemptRecordingDownloadUrl: (...args: unknown[]) => mockRecordingApi.getAttemptRecordingDownloadUrl(...args),
    getRecordingDownloadUrl: (...args: unknown[]) => mockRecordingApi.getRecordingDownloadUrl(...args),
  },
  ApiError: class extends Error {},
}));

const T0 = Date.parse('2026-10-05T03:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function leg(over: Partial<CandidatePhoneAttempt> = {}): CandidatePhoneAttempt {
  return {
    id: 'a',
    attempt_seq: 1,
    admitted_at: iso(T0),
    answered_at: iso(T0 + 10_000),
    ended_at: iso(T0 + 85_000),
    state: 'ended',
    abandon_reason: null,
    outcome_class: 'disconnected',
    duration_sec: 75,
    connected_from: iso(T0 + 10_000),
    connected_to: iso(T0 + 85_000),
    connected_to_source: 'ledger',
    connected_sec: 75,
    recorded_sec: 53.2,
    recorded_sec_estimated: true,
    tail_may_be_missing: true,
    recording: { state: 'unavailable', reason: 'deleted' },
    transcript: null,
    ...over,
  } as CandidatePhoneAttempt;
}

function renderRow(row: CandidatePhoneAttempt) {
  return render(
    <ul>
      <SessionLegRow leg={row} index={0} total={2} sessionId="s" />
    </ul>,
  );
}

describe('SessionLegRow', () => {
  it('a deleted recording shows no recorded length and no tail note; the call facts stay', () => {
    const { container } = renderRow(leg());
    const text = container.textContent ?? '';
    expect(text).toContain('Recording deleted');
    expect(text).not.toContain('Recorded');
    expect(container.querySelector('[data-leg-note="tail"]')).toBeNull();
    expect(text).toMatch(/Connected \d\d:\d\d/);
  });

  it('a withdrawn recording is gated the same way', () => {
    const { container } = renderRow(leg({ recording: { state: 'unavailable', reason: 'revoked' } }));
    expect(container.textContent).not.toContain('Recorded');
    expect(container.querySelector('[data-leg-note="tail"]')).toBeNull();
  });

  it('each leg player names its controls by its leg, so two legs never share a button name (WCAG 2.4.6)', () => {
    const ready = { state: 'ready', reason: null } as unknown as CandidatePhoneAttempt['recording'];
    render(
      <ul>
        <SessionLegRow leg={leg({ id: 'a', recording: ready })} index={0} total={2} sessionId="s" />
        <SessionLegRow leg={leg({ id: 'b', recording: ready })} index={1} total={2} sessionId="s" />
      </ul>,
    );
    // The visible text leads the name (label in name, WCAG 2.5.3).
    expect(screen.getByRole('button', { name: 'Load recording, Call 1 of 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load recording, Call 2 of 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load recording' })).toBeNull();
  });

  it('says reconnect only of a call the host says was reached through a drop', () => {
    const { rerender } = render(<ul><SessionLegRow leg={leg()} index={1} total={2} sessionId="s" reconnect /></ul>);
    expect(screen.getByText('Call 2 of 2 · reconnect')).toBeInTheDocument();
    rerender(<ul><SessionLegRow leg={leg()} index={1} total={2} sessionId="s" /></ul>);
    expect(screen.getByText('Call 2 of 2')).toBeInTheDocument();
  });

  it('a reconciler-detected end reads approximate, with no length', () => {
    const { container } = renderRow(leg({ connected_to_source: 'detected', connected_sec: null }));
    const text = container.textContent ?? '';
    expect(text).toMatch(/Connected from \d\d:\d\d IST/);
    expect(text).toMatch(/End time approximate: our check found the call over by \d\d:\d\d IST\./);
    expect(text).not.toContain('1m 15s');
  });
});

/*
 * Stage 6 of the Review congestion plan, inside the scope Legal approved on 2026-11-09 (owner's report):
 * on one call with a working tape, the connected-time line, Load recording and "Recording processing; it
 * may not play yet." sit behind one press, word for word. The consent tag and every note about a dropped
 * call, an approximate end time, a missing end or missing audio stay in view.
 */
describe('SessionLegRow, folded on one call with a working tape', () => {
  const READY = { state: 'ready', reason: null } as unknown as CandidatePhoneAttempt['recording'];
  const PROCESSING = { state: 'processing', reason: null } as unknown as CandidatePhoneAttempt['recording'];
  const playable = (over: Partial<CandidatePhoneAttempt> = {}) => leg({ recording: READY, tail_may_be_missing: false, ...over });

  function renderOne(row: CandidatePhoneAttempt, props: Partial<SessionLegRowProps> & { ref?: Ref<RecordingPlayerHandle> } = {}) {
    return render(
      <ul>
        <SessionLegRow leg={row} index={0} total={1} sessionId="s" foldable tapeDriven {...props} />
      </ul>,
    );
  }
  const arrow = () => screen.getByRole('button', { name: /^Call 1 of 1 · first call/ });
  const connectedLine = () => screen.getByText(/^Connected /);
  const loadRecording = () => screen.getByRole('button', { name: 'Load recording, Call 1 of 1', hidden: true });

  beforeEach(() => {
    vi.clearAllMocks();
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 2 });
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/leg' });
  });

  it('closes to the title, the outcome and the recorded length, with an arrow that says it is closed', () => {
    renderOne(playable());
    expect(arrow()).toHaveAttribute('aria-expanded', 'false');
    expect(arrow()).toHaveAccessibleName('Call 1 of 1 · first call · Dropped mid-call · Recorded ≈53s (estimated)');
    expect(arrow()).toBeVisible();
    expect(connectedLine()).not.toBeVisible();
    expect(loadRecording()).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load recording, Call 1 of 1' })).toBeNull();
  });

  it('the arrow controls exactly what it hides', () => {
    renderOne(playable());
    const controlled = arrow().getAttribute('aria-controls')!.split(' ').map((id) => document.getElementById(id));
    expect(controlled).toHaveLength(2);
    expect(controlled[0]).toBe(connectedLine());
    expect(controlled[1]).toContainElement(loadRecording());
  });

  it('one press opens the connected-time line and Load recording word for word, and another closes them', () => {
    renderOne(playable());
    fireEvent.click(arrow());
    expect(arrow()).toHaveAttribute('aria-expanded', 'true');
    expect(connectedLine()).toBeVisible();
    expect(connectedLine().textContent).toMatch(/^Connected \d\d:\d\d–\d\d:\d\d IST \(1m 15s\) · Recorded ≈53s \(estimated\)$/);
    expect(screen.getByRole('button', { name: 'Load recording, Call 1 of 1' })).toHaveTextContent(/^Load recording$/);
    // Open, the length is printed once, where it always was. The arrow keeps it in its name, unprinted.
    const lengths = screen.getAllByText(/Recorded ≈53s/);
    expect(lengths.filter((el) => !el.closest('.sr-only'))).toEqual([connectedLine()]);
    expect(lengths.filter((el) => el.closest('.sr-only')).every((el) => arrow().contains(el))).toBe(true);
    fireEvent.click(arrow());
    expect(arrow()).toHaveAttribute('aria-expanded', 'false');
    expect(connectedLine()).not.toBeVisible();
  });

  it('"Recording processing; it may not play yet." goes behind the press, word for word', () => {
    renderOne(playable({ recording: PROCESSING }));
    const note = screen.getByText('Recording processing; it may not play yet.');
    expect(note).not.toBeVisible();
    fireEvent.click(arrow());
    expect(note).toBeVisible();
  });

  it.each([
    ['the before-consent tag', { consent_stage: 'before_consent' }, 'Recorded before consent'],
    ['the withdrawn-consent tag', { consent_stage: 'consent_withdrawn' }, 'Consent withdrawn – recording kept'],
    ['the callback tag', { consent_stage: 'deferred_after_consent' }, 'Callback requested after consent – recording kept'],
    ['the approximate end time', { connected_to_source: 'detected' }, /^End time approximate: our check found the call over by \d\d:\d\d IST\.$/],
    ['a dropped line whose end was not seen', { connected_to_source: 'unobserved', consent_stage: 'after_consent' }, /^Line dropped; end not observed \(detected \d\d:\d\d IST by timeout\)\.$/],
    ['a missing end', { connected_to_source: 'unobserved', consent_stage: 'before_consent' }, /^End not observed \(detected \d\d:\d\d IST by timeout\)\.$/],
    ['the tail note', { tail_may_be_missing: true }, LEG_TAIL_NOTE],
  ] as const)('%s stays in view while closed', (_what, over, words) => {
    renderOne(playable(over as Partial<CandidatePhoneAttempt>));
    expect(arrow()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(words)).toBeVisible();
  });

  it('opens by itself when the call cannot play, and its reason stays in view when closed', () => {
    renderOne(leg({ recording: { state: 'unavailable', reason: 'deleted' } }));
    expect(arrow()).toHaveAttribute('aria-expanded', 'true');
    expect(connectedLine()).toBeVisible();
    fireEvent.click(arrow());
    expect(arrow()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Recording deleted')).toBeVisible();
  });

  it('opens by itself when the call sits before the clock: Load recording is then the only way to play it', () => {
    renderOne(playable(), { beforeClock: true });
    expect(arrow()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Load recording, Call 1 of 1' })).toBeVisible();
  });

  it('keeps the player mounted while closed: a cue plays through it and the block stays closed', async () => {
    const ref = createRef<RecordingPlayerHandle>();
    renderOne(playable(), { ref });
    act(() => ref.current!.playFrom(12));
    await waitFor(() => expect(mockRecordingApi.getAttemptRecordingDownloadUrl).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(document.querySelector('audio')).not.toBeNull();
    expect(arrow()).toHaveAttribute('aria-expanded', 'false');
  });

  /*
   * Legal's yes covers Load recording, not what it turns into. Once a recording is asked for, from the
   * block or the tape, its progress, the player, Download file and Refresh link, or the reason it failed
   * stay in view whatever the arrow says. Only the connected-time line is left behind the press.
   */
  it('once a cue asks for the recording, its progress and then the player, Download file and Refresh link are in view while closed', async () => {
    let answer: (value: { url: string }) => void = () => undefined;
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const ref = createRef<RecordingPlayerHandle>();
    renderOne(playable(), { ref });
    act(() => ref.current!.playFrom(12));
    expect(screen.getByText('Loading recording…')).toBeVisible();
    await act(async () => answer({ url: 'https://x.invalid/leg' }));
    expect(arrow()).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('audio')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download file, Call 1 of 1' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh link, Call 1 of 1' })).toBeVisible();
    // The arrow now folds the connected-time line alone, and says so.
    expect(connectedLine()).not.toBeVisible();
    expect(arrow()).toHaveAttribute('aria-controls', connectedLine().id);
    fireEvent.click(arrow());
    expect(connectedLine()).toBeVisible();
    fireEvent.click(arrow());
    expect(connectedLine()).not.toBeVisible();
    expect(document.querySelector('audio')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download file, Call 1 of 1' })).toBeVisible();
  });

  it('a recording loaded from the open block stays in view when the arrow closes it', async () => {
    renderOne(playable());
    fireEvent.click(arrow());
    fireEvent.click(screen.getByRole('button', { name: 'Load recording, Call 1 of 1' }));
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    fireEvent.click(arrow());
    expect(arrow()).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('audio')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download file, Call 1 of 1' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh link, Call 1 of 1' })).toBeVisible();
  });

  it.each(['Recording is quarantined', 'Recording not found', 'Recording integrity verification failed'])(
    'a load from the open block that fails keeps "%s" and Try again in view when the arrow closes it',
    async (reason) => {
      mockRecordingApi.getAttemptRecordingDownloadUrl.mockRejectedValue(new Error(reason));
      renderOne(playable());
      fireEvent.click(arrow());
      fireEvent.click(screen.getByRole('button', { name: 'Load recording, Call 1 of 1' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(reason);
      fireEvent.click(arrow());
      expect(arrow()).toHaveAttribute('aria-expanded', 'false');
      expect(connectedLine()).not.toBeVisible();
      expect(screen.getByText(reason)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Try again, Call 1 of 1' })).toBeVisible();
    },
  );

  it('the arrow keeps one name, closed or open: its state is in aria-expanded alone', () => {
    renderOne(playable());
    const name = 'Call 1 of 1 · first call · Dropped mid-call · Recorded ≈53s (estimated)';
    expect(arrow()).toHaveAccessibleName(name);
    fireEvent.click(arrow());
    expect(arrow()).toHaveAttribute('aria-expanded', 'true');
    expect(arrow()).toHaveAccessibleName(name);
    fireEvent.click(arrow());
    expect(arrow()).toHaveAccessibleName(name);
  });

  it('a load that fails opens it, so the reason and Try again are in view', async () => {
    mockRecordingApi.getAttemptRecordingDownloadUrl.mockRejectedValue(new Error('Recording not found'));
    const ref = createRef<RecordingPlayerHandle>();
    renderOne(playable(), { ref });
    act(() => ref.current!.playFrom(12));
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Recording not found');
    expect(within(failure).getByRole('button', { name: 'Try again, Call 1 of 1' })).toBeVisible();
    expect(arrow()).toHaveAttribute('aria-expanded', 'true');
  });

  it('works from the keyboard: Tab reaches the arrow, and Enter and Space open and close it', async () => {
    const user = userEvent.setup();
    renderOne(playable());
    await user.tab();
    expect(arrow()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(arrow()).toHaveAttribute('aria-expanded', 'true');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Load recording, Call 1 of 1' })).toHaveFocus();
    await user.tab({ shift: true });
    await user.keyboard(' ');
    expect(arrow()).toHaveAttribute('aria-expanded', 'false');
  });

  it('without the fold (several calls, or no tape) the block is in full, with no arrow', () => {
    renderOne(playable({ connected_to_source: 'detected' }), { foldable: false });
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
    expect(screen.queryByRole('button', { expanded: true })).toBeNull();
    expect(connectedLine()).toBeVisible();
    expect(screen.getByRole('button', { name: 'Load recording, Call 1 of 1' })).toBeVisible();
    expect(screen.getByText(/^End time approximate/)).toBeVisible();
    // The first line is as it was: the length is on the line under it, once.
    expect(screen.getAllByText(/Recorded ≈53s/)).toHaveLength(1);
  });
});
