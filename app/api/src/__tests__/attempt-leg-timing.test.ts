/**
 * M013 S02 (T07): the pure per-leg timing rule and its session roll-up.
 * Synthetic rows; the timings are the 9f60523d / 32757295 shapes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  attemptLegTiming,
  isUnobservedReclaim,
  sessionRecordedFacts,
  withoutRecordingFacts,
  TAIL_NOTE_TOLERANCE_SEC,
  WORKER_INBAND_EGRESS_ID_PREFIX,
  WORKER_MP3_BITRATE_BPS,
  type AttemptLegTimingRow,
} from '../lib/attempt-leg-timing.js';

const ID = '00000000-0000-4000-8000-0000000004a1';

function row(fields: Partial<AttemptLegTimingRow> = {}): AttemptLegTimingRow {
  return {
    answered_at: '2026-10-06T03:30:46.822Z',
    ended_at: '2026-10-06T03:32:02.356Z',
    state: 'ended',
    outcome_class: 'disconnected',
    abandon_reason: null,
    observed_ended_at: null,
    recording_started_at_ms: null,
    recording_duration_ms: null,
    recording_tail_flushed: null,
    recording_object_key: `phone-${ID}-worker.mp3`,
    recording_size_bytes: 425_708,
    recording_content_type: 'audio/mpeg',
    egress_id: `EG_worker_${ID}`,
    egress_status: 'complete',
    ...fields,
  };
}

const reclaimed = (fields: Partial<AttemptLegTimingRow> = {}) => row({
  answered_at: '2026-10-06T03:34:49.612Z',
  ended_at: '2026-10-06T03:40:57.456Z',
  state: 'abandoned',
  outcome_class: null,
  recording_size_bytes: 140_972,
  ...fields,
});

describe('attemptLegTiming', () => {
  it('mirrors the worker and egress constants it restates', () => {
    const recording = readFileSync(fileURLToPath(new URL('../../../voice-livekit/recording.py', import.meta.url)), 'utf8');
    expect(recording).toMatch(new RegExp(`_MP3_BITRATE_BPS\\s*=\\s*${WORKER_MP3_BITRATE_BPS.toLocaleString('en-US').replace(/,/g, '_')}\\b`));
    const egress = readFileSync(fileURLToPath(new URL('../lib/recording-egress.ts', import.meta.url)), 'utf8');
    expect(egress).toContain(`const WORKER_INBAND_EGRESS_ID_PREFIX = '${WORKER_INBAND_EGRESS_ID_PREFIX}';`);
  });

  it('uses the ledger end and the size estimate for a legacy worker leg', () => {
    expect(attemptLegTiming(row())).toEqual({
      connected_from: '2026-10-06T03:30:46.822Z',
      connected_to: '2026-10-06T03:32:02.356Z',
      connected_to_source: 'ledger',
      connected_sec: 75.534,
      recorded_sec: 53.2,
      recorded_sec_estimated: true,
      recording_started_at_ms: null,
      tail_may_be_missing: true,
      has_recording: true,
    });
  });

  it('prefers the observed end over the ledger end', () => {
    const t = attemptLegTiming(row({ observed_ended_at: '2026-10-06T03:31:48.296Z' }));
    expect(t).toMatchObject({ connected_to: '2026-10-06T03:31:48.296Z', connected_to_source: 'observed', connected_sec: 61.474 });
  });

  it('an EARLIER ledger end beats the observed end (0118 least(observed, ended)), unless it is a sweep detection', () => {
    const skewed = attemptLegTiming(row({ observed_ended_at: '2026-10-06T03:32:05.000Z' }));
    expect(skewed).toMatchObject({ connected_to: '2026-10-06T03:32:02.356Z', connected_to_source: 'ledger', connected_sec: 75.534 });
    const swept = attemptLegTiming(row({ observed_ended_at: '2026-10-06T03:32:05.000Z', end_detected_by_sweep: true }));
    expect(swept).toMatchObject({ connected_to: '2026-10-06T03:32:05.000Z', connected_to_source: 'observed' });
  });

  it('a reconciler-detected end is an upper bound: detected, detection time kept, no exact length', () => {
    // 9f60523d leg A: the sweep saw the empty room at 03:32:02, ~14 s after
    // the SIP leave. Not "Connected 03:30-03:32 (1m 16s)".
    const t = attemptLegTiming(row({ end_detected_by_sweep: true }));
    expect(t).toMatchObject({
      connected_from: '2026-10-06T03:30:46.822Z',
      connected_to: '2026-10-06T03:32:02.356Z',
      connected_to_source: 'detected',
      connected_sec: null,
      recorded_sec: 53.2,
    });
    // An observed SIP leave on the same leg is the real end.
    expect(attemptLegTiming(row({ end_detected_by_sweep: true, observed_ended_at: '2026-10-06T03:31:48.296Z' })))
      .toMatchObject({ connected_to_source: 'observed', connected_sec: 61.474 });
    // A reclaim stays unobserved whatever the sweep flag says.
    expect(attemptLegTiming(reclaimed({ end_detected_by_sweep: true })).connected_to_source).toBe('unobserved');
  });

  it('withoutRecordingFacts withholds the audio facts and keeps the call facts', () => {
    const t = withoutRecordingFacts(attemptLegTiming(row({ recording_started_at_ms: 1_791_345_611_050 })));
    expect(t).toMatchObject({
      connected_to_source: 'ledger',
      connected_sec: 75.534,
      recorded_sec: null,
      recorded_sec_estimated: false,
      recording_started_at_ms: null,
      tail_may_be_missing: false,
      has_recording: false,
    });
  });

  it('a lease reclaim with no observed end is unobserved: detection time kept, no length', () => {
    const t = attemptLegTiming(reclaimed());
    expect(t).toMatchObject({
      connected_to: '2026-10-06T03:40:57.456Z',
      connected_to_source: 'unobserved',
      connected_sec: null,
      recorded_sec: 17.6,
      tail_may_be_missing: true,
    });
    // ...and an observed end turns the same reclaimed leg into a real span.
    expect(attemptLegTiming(reclaimed({ observed_ended_at: '2026-10-06T03:35:08.330Z' })))
      .toMatchObject({ connected_to_source: 'observed', connected_sec: 18.718 });
  });

  it('matches the 0118 §3a reclaim signature exactly', () => {
    expect(isUnobservedReclaim(reclaimed())).toBe(true);
    // 0083 infra defer is not a reclaim.
    expect(isUnobservedReclaim(reclaimed({ abandon_reason: 'infra_deferred' }))).toBe(false);
    // An abandoned row WITH an outcome was ended by an event, not the sweep.
    expect(isUnobservedReclaim(reclaimed({ outcome_class: 'disconnected' }))).toBe(false);
    expect(isUnobservedReclaim(reclaimed({ state: 'ended' }))).toBe(false);
    expect(isUnobservedReclaim(reclaimed({ ended_at: null }))).toBe(false);
    expect(isUnobservedReclaim(reclaimed({ observed_ended_at: '2026-10-06T03:35:08.330Z' }))).toBe(false);
    // The SQL body states the same predicate.
    const sql = readFileSync(
      fileURLToPath(new URL('../../../supabase/migrations/0118_phone_recording_integrity.sql', import.meta.url)),
      'utf8',
    );
    const body = sql.slice(sql.indexOf('create or replace function screening_v2.phone_session_leg_duration('));
    for (const clause of [
      'a.observed_ended_at is null',
      "a.state = 'abandoned'",
      'a.outcome_class is null',
      'a.abandon_reason is null',
      'a.ended_at is not null',
    ]) expect(body).toContain(clause);
  });

  it('never answered, or still live: no connected window', () => {
    expect(attemptLegTiming(row({ answered_at: null }))).toMatchObject({
      connected_from: null, connected_to: null, connected_to_source: null, connected_sec: null,
    });
    expect(attemptLegTiming(row({ ended_at: null }))).toMatchObject({
      connected_from: '2026-10-06T03:30:46.822Z', connected_to: null, connected_to_source: null, connected_sec: null,
    });
  });

  it('a negative or unparseable span is null, never a negative length', () => {
    expect(attemptLegTiming(row({ observed_ended_at: '2026-10-06T03:30:40.000Z' })).connected_sec).toBeNull();
    expect(attemptLegTiming(row({ ended_at: 'not-a-time' })).connected_to_source).toBeNull();
  });

  it('the true audio length beats the estimate; a zero or junk length is unknown', () => {
    expect(attemptLegTiming(row({ recording_duration_ms: 53_180 }))).toMatchObject({ recorded_sec: 53.18, recorded_sec_estimated: false });
    // PostgREST may return a bigint as a string.
    expect(attemptLegTiming(row({ recording_duration_ms: '53180' }))).toMatchObject({ recorded_sec: 53.18 });
    expect(attemptLegTiming(row({ recording_duration_ms: 0 })).recorded_sec_estimated).toBe(true);
    expect(attemptLegTiming(row({ recording_started_at_ms: '1791345611050' })).recording_started_at_ms).toBe(1_791_345_611_050);
  });

  it('estimates only a worker MP3: no estimate for LiveKit egress, OGG, or a missing object', () => {
    expect(attemptLegTiming(row({ egress_id: 'EG_livekit123' })).recorded_sec).toBeNull();
    expect(attemptLegTiming(row({ egress_id: null })).recorded_sec).toBeNull();
    expect(attemptLegTiming(row({ recording_content_type: 'audio/ogg' })).recorded_sec).toBeNull();
    expect(attemptLegTiming(row({ recording_object_key: null })).recorded_sec).toBeNull();
    expect(attemptLegTiming(row({ recording_size_bytes: 0 })).recorded_sec).toBeNull();
  });

  it('a failed capture has no recorded length and no tail note', () => {
    expect(attemptLegTiming(row({ egress_status: 'failed', recording_duration_ms: 12_000 })))
      .toMatchObject({ recorded_sec: null, tail_may_be_missing: false });
  });

  it('tail note: worker recordings whose flush is not known to have run, unless the lengths agree', () => {
    expect(attemptLegTiming(row({ recording_tail_flushed: true })).tail_may_be_missing).toBe(false);
    expect(attemptLegTiming(row({ recording_tail_flushed: false })).tail_may_be_missing).toBe(true);
    // Not a worker recording: the flush does not apply.
    expect(attemptLegTiming(row({ egress_id: 'EG_livekit123' })).tail_may_be_missing).toBe(false);
    // No recording at all: nothing to be short.
    expect(attemptLegTiming(row({ recording_object_key: null })).tail_may_be_missing).toBe(false);
    // Within the tolerance of the connected span: covered (32757295 shape).
    const covered = attemptLegTiming(row({
      answered_at: '2026-10-05T05:00:20.000Z',
      ended_at: '2026-10-05T05:00:54.600Z',
      outcome_class: 'voicemail',
      recording_size_bytes: 261_600,
    }));
    expect(covered).toMatchObject({ connected_sec: 34.6, recorded_sec: 32.7, tail_may_be_missing: false });
    expect(TAIL_NOTE_TOLERANCE_SEC).toBe(3);
    // A durationless worker leg (the duration is unknown, the object exists)
    // still carries the note: the note is keyed on the flush, not the length.
    expect(attemptLegTiming(row({ recording_size_bytes: null })).tail_may_be_missing).toBe(true);
  });
});

describe('sessionRecordedFacts', () => {
  it('9f60523d: 70.8 s across 2 legs, connected not complete', () => {
    expect(sessionRecordedFacts([attemptLegTiming(row()), attemptLegTiming(reclaimed())])).toEqual({
      recorded_total_sec: 70.8,
      recorded_legs: 2,
      recorded_unknown_legs: 0,
      connected_complete: false,
      connected_total_sec: null,
    });
  });

  it('no legs: all null; legs but nothing answered: connected facts null', () => {
    expect(sessionRecordedFacts([])).toEqual({
      recorded_total_sec: null,
      recorded_legs: null,
      recorded_unknown_legs: null,
      connected_complete: null,
      connected_total_sec: null,
    });
    expect(sessionRecordedFacts([attemptLegTiming(row({ answered_at: null, recording_object_key: null }))])).toEqual({
      recorded_total_sec: null, recorded_legs: 0, recorded_unknown_legs: 0, connected_complete: null, connected_total_sec: null,
    });
  });

  it('a leg WITH audio of unknown length is counted, so the total reads as a lower bound', () => {
    // A 53 s OGG fallback (close-timeout manifest: duration None) beside an
    // 18 s MP3: the total is 17.6 s of KNOWN length plus 1 unknown leg.
    const facts = sessionRecordedFacts([
      attemptLegTiming(row({ recording_content_type: 'audio/ogg', recording_object_key: `phone-${ID}-worker.ogg` })),
      attemptLegTiming(reclaimed()),
    ]);
    expect(facts).toMatchObject({ recorded_total_sec: 17.6, recorded_legs: 1, recorded_unknown_legs: 1 });
    // A withheld (erased / revoked) leg counts in neither.
    expect(sessionRecordedFacts([
      withoutRecordingFacts(attemptLegTiming(row())),
      attemptLegTiming(reclaimed()),
    ])).toMatchObject({ recorded_total_sec: 17.6, recorded_legs: 1, recorded_unknown_legs: 0 });
  });

  it('a reconciler-detected leg makes connected incomplete (no "on the call" figure)', () => {
    expect(sessionRecordedFacts([attemptLegTiming(row({ end_detected_by_sweep: true }))]))
      .toMatchObject({ connected_complete: false, connected_total_sec: null });
  });

  it('a live answered leg makes connected incomplete', () => {
    expect(sessionRecordedFacts([attemptLegTiming(row()), attemptLegTiming(row({ ended_at: null }))]))
      .toMatchObject({ connected_complete: false, connected_total_sec: null });
  });

  it('all ends known: the connected sum', () => {
    expect(sessionRecordedFacts([
      attemptLegTiming(row()),
      attemptLegTiming(reclaimed({ observed_ended_at: '2026-10-06T03:35:08.330Z' })),
    ])).toMatchObject({ connected_complete: true, connected_total_sec: 94.252 });
  });
});
