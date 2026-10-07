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
    recording_ready: true,
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
      answered_after_session_end: false,
    });
  });

  it('prefers the observed end over the ledger end', () => {
    const t = attemptLegTiming(row({ observed_ended_at: '2026-10-06T03:31:48.296Z' }));
    expect(t).toMatchObject({ connected_to: '2026-10-06T03:31:48.296Z', connected_to_source: 'observed', connected_sec: 61.474 });
  });

  it('an EARLIER ledger end beats the observed end (0125 least(observed, ended)), unless it is a sweep detection', () => {
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

  it('a leg reclaimed AFTER its completed session ended is bounded by the session end (0125 §3a)', () => {
    // Still live when the worker completed the session at 03:38:00 (its
    // heartbeat held the lease to 03:38:30); the reclaim landed at 03:40:57.
    // duration_sec (trigger and backfill alike) counts it to the session end,
    // so the per-leg read does too: a ledger-style bound.
    const held = { lease_expires_at: '2026-10-06T03:38:30.000Z' };
    const t = attemptLegTiming(reclaimed({ ...held, session_ended_at: '2026-10-06T03:38:00.000Z' }));
    expect(t).toMatchObject({
      connected_from: '2026-10-06T03:34:49.612Z',
      connected_to: '2026-10-06T03:38:00.000Z',
      connected_to_source: 'ledger',
      connected_sec: 190.388,
    });
    expect(sessionRecordedFacts([t])).toMatchObject({ connected_complete: true, connected_total_sec: 190.388 });
    // Reclaimed at or before the session end: unobserved, as in SQL.
    expect(attemptLegTiming(reclaimed({ session_ended_at: '2026-10-06T03:43:59.622Z' })).connected_to_source).toBe('unobserved');
    expect(attemptLegTiming(reclaimed({ session_ended_at: '2026-10-06T03:40:57.456Z' })).connected_to_source).toBe('unobserved');
    // No completed session end known (live or not completed): unobserved.
    expect(attemptLegTiming(reclaimed({ session_ended_at: null })).connected_to_source).toBe('unobserved');
    // An observed end still wins over the session-end bound.
    expect(attemptLegTiming(reclaimed({
      ...held,
      session_ended_at: '2026-10-06T03:38:00.000Z',
      observed_ended_at: '2026-10-06T03:35:08.330Z',
    }))).toMatchObject({ connected_to_source: 'observed', connected_sec: 18.718 });
  });

  it('finalize-before-reclaim: a session completed after the lease LAPSED does not bound the leg (review round 3)', () => {
    // The worker stopped renewing at 03:35:20. finalize's lapsed-lease arm
    // completed the session at 03:38:21 (lease + 181 s), and the delayed
    // reclaim ran at 03:40:57. That session end is the sweep's clock: the
    // leg's end is unknown, never ~3 minutes of dead air as connected time.
    const lapsed = attemptLegTiming(reclaimed({
      lease_expires_at: '2026-10-06T03:35:20.000Z',
      session_ended_at: '2026-10-06T03:38:21.000Z',
    }));
    expect(lapsed).toMatchObject({
      connected_to: '2026-10-06T03:40:57.456Z',
      connected_to_source: 'unobserved',
      connected_sec: null,
    });
    expect(sessionRecordedFacts([lapsed])).toMatchObject({
      connected_complete: false, connected_total_sec: null, connected_unobserved_legs: 1,
    });
    // An unknown lease expiry is not evidence the worker was alive: unobserved.
    expect(attemptLegTiming(reclaimed({ session_ended_at: '2026-10-06T03:38:00.000Z' })).connected_to_source)
      .toBe('unobserved');
    // The SQL predicate itself is unchanged (duration_sec keeps the bound).
    expect(isUnobservedReclaim(reclaimed({
      lease_expires_at: '2026-10-06T03:35:20.000Z',
      session_ended_at: '2026-10-06T03:38:21.000Z',
    }))).toBe(false);
  });

  it('caps every leg end at the completed session end, as 0125 §3a least(..., session end) does', () => {
    const sessionEnd = '2026-10-06T03:32:00.000Z';
    // The agent completed the session at 03:32:00; the SIP leave arrived 3 s
    // later. SQL stores answered -> session end; so does the per-leg read.
    const observedLate = attemptLegTiming(row({
      ended_at: '2026-10-06T03:32:04.000Z',
      observed_ended_at: '2026-10-06T03:32:03.000Z',
      session_ended_at: sessionEnd,
    }));
    expect(observedLate).toMatchObject({ connected_to: sessionEnd, connected_to_source: 'ledger', connected_sec: 73.178 });
    // A ledger end past the session end: capped the same way.
    const ledgerLate = attemptLegTiming(row({ session_ended_at: sessionEnd }));
    expect(ledgerLate).toMatchObject({ connected_to: sessionEnd, connected_to_source: 'ledger', connected_sec: 73.178 });
    // An end before the session end is untouched.
    expect(attemptLegTiming(row({ session_ended_at: '2026-10-06T03:35:00.000Z' })))
      .toMatchObject({ connected_to: '2026-10-06T03:32:02.356Z', connected_to_source: 'ledger', connected_sec: 75.534 });
  });

  it('a leg answered AFTER the completed session ended is left out of the connected roll-up, as SQL does', () => {
    const sessionEnd = '2026-10-06T03:33:00.000Z';
    const inSession = attemptLegTiming(row({ session_ended_at: sessionEnd }));
    // Answered at 03:34:49, after the session ended at 03:33:00, then
    // reclaimed: its own window is reported (unobserved), unbounded by a
    // session it is not part of, and it does not make the session's
    // connected time unknown.
    const after = attemptLegTiming(reclaimed({ session_ended_at: sessionEnd }));
    expect(after).toMatchObject({
      answered_after_session_end: true,
      connected_from: '2026-10-06T03:34:49.612Z',
      connected_to: '2026-10-06T03:40:57.456Z',
      connected_to_source: 'unobserved',
      connected_sec: null,
    });
    expect(sessionRecordedFacts([inSession, after])).toMatchObject({
      connected_complete: true,
      connected_total_sec: 75.534,
      connected_unobserved_legs: 0,
      // Its recording still counts: audio is audio.
      recorded_legs: 2,
    });
    // An after-the-end leg with an exact end is not capped into a negative span.
    expect(attemptLegTiming(reclaimed({
      session_ended_at: sessionEnd,
      observed_ended_at: '2026-10-06T03:35:08.330Z',
    }))).toMatchObject({ connected_to_source: 'observed', connected_sec: 18.718, answered_after_session_end: true });
  });

  it('matches the 0125 §3a reclaim signature exactly', () => {
    expect(isUnobservedReclaim(reclaimed())).toBe(true);
    // The session-end clause: a reclaim after the completed session ended is
    // not unobserved; at or before it, it is.
    expect(isUnobservedReclaim(reclaimed({ session_ended_at: '2026-10-06T03:38:00.000Z' }))).toBe(false);
    expect(isUnobservedReclaim(reclaimed({ session_ended_at: '2026-10-06T03:40:57.456Z' }))).toBe(true);
    expect(isUnobservedReclaim(reclaimed({ session_ended_at: '2026-10-06T03:43:59.622Z' }))).toBe(true);
    // 0083 infra defer is not a reclaim.
    expect(isUnobservedReclaim(reclaimed({ abandon_reason: 'infra_deferred' }))).toBe(false);
    // An abandoned row WITH an outcome was ended by an event, not the sweep.
    expect(isUnobservedReclaim(reclaimed({ outcome_class: 'disconnected' }))).toBe(false);
    expect(isUnobservedReclaim(reclaimed({ state: 'ended' }))).toBe(false);
    expect(isUnobservedReclaim(reclaimed({ ended_at: null }))).toBe(false);
    expect(isUnobservedReclaim(reclaimed({ observed_ended_at: '2026-10-06T03:35:08.330Z' }))).toBe(false);
    // The SQL body states the same predicate.
    const sql = readFileSync(
      fileURLToPath(new URL('../../../supabase/migrations/0125_phone_recording_integrity.sql', import.meta.url)),
      'utf8',
    );
    const body = sql.slice(sql.indexOf('create or replace function screening_v2.phone_session_leg_duration('));
    for (const clause of [
      'a.observed_ended_at is null',
      "a.state = 'abandoned'",
      'a.outcome_class is null',
      'a.abandon_reason is null',
      'a.ended_at is not null',
      'a.ended_at <= p_session_ended_at',
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
      connected_unobserved_legs: 1,
      connected_detected_legs: 0,
      connected_open_legs: 0,
    });
  });

  it('no legs: all null; legs but nothing answered: connected facts null', () => {
    expect(sessionRecordedFacts([])).toEqual({
      recorded_total_sec: null,
      recorded_legs: null,
      recorded_unknown_legs: null,
      connected_complete: null,
      connected_total_sec: null,
      connected_unobserved_legs: null,
      connected_detected_legs: null,
      connected_open_legs: null,
    });
    expect(sessionRecordedFacts([attemptLegTiming(row({ answered_at: null, recording_object_key: null }))])).toEqual({
      recorded_total_sec: null, recorded_legs: 0, recorded_unknown_legs: 0, connected_complete: null, connected_total_sec: null,
      connected_unobserved_legs: 0, connected_detected_legs: 0, connected_open_legs: 0,
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

  it('a key bound at prepare but never uploaded is NOT audio of unknown length', () => {
    // The worker died before /recording/complete and nothing latched
    // `failed`: the key exists, no object, no stamped length.
    const unuploaded = attemptLegTiming(reclaimed({
      recording_ready: false,
      recording_size_bytes: null,
      recording_content_type: null,
      egress_status: 'active',
    }));
    expect(unuploaded).toMatchObject({ has_recording: false, recorded_sec: null, tail_may_be_missing: false });
    expect(sessionRecordedFacts([attemptLegTiming(row({ recording_duration_ms: 53_180 })), unuploaded]))
      .toMatchObject({ recorded_total_sec: 53.18, recorded_legs: 1, recorded_unknown_legs: 0 });
    // A stamped length (only /recording/complete writes it, after the
    // upload) is audio even before the ready flag is read.
    expect(attemptLegTiming(row({ recording_ready: false, recording_duration_ms: 12_000 })).has_recording).toBe(true);
  });

  it('a reconciler-detected leg makes connected incomplete (no "on the call" figure)', () => {
    expect(sessionRecordedFacts([attemptLegTiming(row({ end_detected_by_sweep: true }))]))
      .toMatchObject({ connected_complete: false, connected_total_sec: null, connected_detected_legs: 1, connected_unobserved_legs: 0 });
  });

  it('a live answered leg makes connected incomplete', () => {
    expect(sessionRecordedFacts([attemptLegTiming(row()), attemptLegTiming(row({ ended_at: null }))]))
      .toMatchObject({ connected_complete: false, connected_total_sec: null, connected_open_legs: 1, connected_unobserved_legs: 0 });
  });

  it('all ends known: the connected sum', () => {
    expect(sessionRecordedFacts([
      attemptLegTiming(row()),
      attemptLegTiming(reclaimed({ observed_ended_at: '2026-10-06T03:35:08.330Z' })),
    ])).toMatchObject({ connected_complete: true, connected_total_sec: 94.252 });
  });
});
