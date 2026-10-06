/**
 * SessionLegRow (M013 S02) — the Review tab's leg row states recording facts
 * only for a recording that can be played, exactly as the Overview list does
 * (review, S02): a deleted or withdrawn leg never reads "Recorded ≈53s" or
 * "may end a few seconds before the call did" next to "Recording deleted".
 * Synthetic timings only.
 */
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { CandidatePhoneAttempt } from '../../../types';
import { SessionLegRow } from '../SessionLegRow';

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

  it('a reconciler-detected end reads approximate, with no length', () => {
    const { container } = renderRow(leg({ connected_to_source: 'detected', connected_sec: null }));
    const text = container.textContent ?? '';
    expect(text).toMatch(/Connected from \d\d:\d\d IST/);
    expect(text).toMatch(/End time approximate: our check found the call over by \d\d:\d\d IST\./);
    expect(text).not.toContain('1m 15s');
  });
});
