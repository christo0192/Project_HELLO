/**
 * The pure half of the R1 recording player: turn -> media position, the link-expiry clock, the
 * automatic re-mint window, what a mint response says to play, and every sentence a staff member can
 * read about a recording. IMPLEMENTER-RULES C6/C7/C8/C11.
 */
import { describe, expect, it } from 'vitest';
import {
  R1_AUTO_REMINT_WINDOW_MS,
  R1_REMINT_GUARD_SEC,
  R1_SEEK_LEAD_SEC,
  R1_SPLIT_DRIFT_SEC,
  attemptLabels,
  clockText,
  driftExceeds,
  durationWords,
  isMintStale,
  isPlayableState,
  isSafeMediaUrl,
  playbackSources,
  r1MediaErrorMessage,
  r1RecordingErrorMessage,
  r1RecordingErrorRetryable,
  r1RecordingStateCopy,
  remintThresholdSec,
  shouldAutoRemint,
  showsRecordingRow,
  turnMediaSec,
  turnOffsetSec,
  viewState,
} from './r1-recording';
import type { R1RecordingPlayback, R1RecordingSummary } from './r1-types';

const START = 1_790_000_000_000; // epoch ms of media t=0

function summary(over: Partial<R1RecordingSummary> = {}): R1RecordingSummary {
  return { state: 'ready', started_at_ms: START, ...over };
}

describe('turnMediaSec / turnOffsetSec (contract C7/C8)', () => {
  it('pins the lead-in at one second', () => {
    expect(R1_SEEK_LEAD_SEC).toBe(1.0);
  });

  it('places a turn at (turn - started_at_ms) seconds, and seeks one second before it', () => {
    expect(turnMediaSec(START + 125_000, summary())).toBe(125);
    expect(turnOffsetSec(START + 125_000, summary())).toBe(124);
  });

  it('keeps millisecond precision', () => {
    expect(turnMediaSec(START + 12_345, summary())).toBeCloseTo(12.345, 6);
    expect(turnOffsetSec(START + 12_345, summary())).toBeCloseTo(11.345, 6);
  });

  it('clamps the lead-in at 0 for a turn in the first second', () => {
    expect(turnOffsetSec(START + 400, summary())).toBe(0);
    expect(turnOffsetSec(START + 1_000, summary())).toBe(0);
    expect(turnOffsetSec(START + 1_001, summary())).toBeCloseTo(0.001, 6);
  });

  it('clamps a turn before the recording began to 0 (still seekable, never negative)', () => {
    expect(turnMediaSec(START - 30_000, summary())).toBe(0);
    expect(turnOffsetSec(START - 30_000, summary())).toBe(0);
  });

  it('is null when the turn has no anchor (an untimed turn stays untimed)', () => {
    for (const bad of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'soon', '', true, {}, 4_102_444_800_000]) {
      expect(turnMediaSec(bad, summary()), String(bad)).toBeNull();
      expect(turnOffsetSec(bad, summary()), String(bad)).toBeNull();
    }
  });

  it('is null when the recording has no anchor', () => {
    expect(turnOffsetSec(START + 5_000, summary({ started_at_ms: null }))).toBeNull();
    expect(turnOffsetSec(START + 5_000, { state: 'ready' })).toBeNull();
    expect(turnOffsetSec(START + 5_000, null)).toBeNull();
    expect(turnOffsetSec(START + 5_000, undefined)).toBeNull();
    expect(turnOffsetSec(START + 5_000, summary({ started_at_ms: 0 }))).toBeNull();
  });

  it('accepts numeric strings (a bigint column can arrive as text) and rejects others', () => {
    expect(turnOffsetSec(String(START + 65_000), summary({ started_at_ms: String(START) as unknown as number }))).toBe(64);
    expect(turnOffsetSec(`${START + 65_000}abc`, summary())).toBeNull();
  });

  it('adds timeline_offset_ms when the API publishes one (default 0)', () => {
    expect(turnOffsetSec(START + 60_000, summary({ timeline_offset_ms: 400 }))).toBeCloseTo(59.4, 6);
    expect(turnOffsetSec(START + 60_000, summary({ timeline_offset_ms: -400 }))).toBeCloseTo(58.6, 6);
    expect(turnOffsetSec(START + 60_000, summary({ timeline_offset_ms: null }))).toBe(59);
    expect(turnOffsetSec(START + 60_000, summary({ timeline_offset_ms: 'x' as unknown as number }))).toBe(59);
  });

  it('does not clamp a turn after the end (the browser clamps the seek)', () => {
    expect(turnOffsetSec(START + 9_999_000, summary({ duration_ms: 60_000 }))).toBe(9_998);
  });
});

describe('the link expiry clock', () => {
  it('re-mints 15 seconds before the link expires', () => {
    expect(R1_REMINT_GUARD_SEC).toBe(15);
    expect(remintThresholdSec(300)).toBe(285);
    expect(isMintStale(1_000, 1_000 + 284_999, 300)).toBe(false);
    expect(isMintStale(1_000, 1_000 + 285_000, 300)).toBe(true);
    expect(isMintStale(1_000, 1_000 + 900_000, 300)).toBe(true);
  });

  it('never re-mints on every play for a very short link', () => {
    expect(remintThresholdSec(20)).toBe(10);
    expect(isMintStale(0, 9_999, 20)).toBe(false);
    expect(isMintStale(0, 10_000, 20)).toBe(true);
  });

  it('a response without a usable lifetime is never stale by the clock', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isMintStale(0, 10_000_000, bad as number | undefined), String(bad)).toBe(false);
    }
  });
});

describe('shouldAutoRemint', () => {
  it('allows the first, then one per 30 s window', () => {
    expect(R1_AUTO_REMINT_WINDOW_MS).toBe(30_000);
    expect(shouldAutoRemint(null, 5)).toBe(true);
    expect(shouldAutoRemint(1_000, 1_000 + 29_999)).toBe(false);
    expect(shouldAutoRemint(1_000, 1_000 + 30_000)).toBe(true);
  });
});

describe('driftExceeds', () => {
  it('corrects only beyond 0.3 s, either direction', () => {
    expect(R1_SPLIT_DRIFT_SEC).toBe(0.3);
    expect(driftExceeds(10, 10.3)).toBe(false);
    expect(driftExceeds(10, 10.31)).toBe(true);
    expect(driftExceeds(10.31, 10)).toBe(true);
    expect(driftExceeds(10, 10)).toBe(false);
  });
});

describe('viewState (unknown fails closed)', () => {
  it('passes the seven known states', () => {
    for (const state of ['none', 'recording', 'processing', 'ready', 'partial', 'failed', 'deleted'] as const) {
      expect(viewState({ state })).toBe(state);
    }
  });

  it('reads anything else as unknown', () => {
    for (const bad of ['READY', 'revoked', '', 'unknown', 7, null, undefined]) {
      expect(viewState({ state: bad } as unknown as R1RecordingSummary), String(bad)).toBe('unknown');
    }
    expect(viewState(null)).toBe('unknown');
    expect(viewState(undefined)).toBe('unknown');
    expect(viewState({} as R1RecordingSummary)).toBe('unknown');
  });

  it('only ready and partial can be played', () => {
    expect(['none', 'recording', 'processing', 'ready', 'partial', 'failed', 'deleted', 'unknown'].filter((s) => isPlayableState(s as never))).toEqual([
      'ready',
      'partial',
    ]);
  });
});

describe('playbackSources', () => {
  const single: R1RecordingPlayback = {
    state: 'ready',
    mode: 'single',
    has_video: true,
    url: 'https://r2.example.test/a?sig=1',
    content_type: 'video/mp4',
    expires_in_sec: 300,
  };

  it('plays a single video file as video', () => {
    expect(playbackSources(single)).toEqual({ kind: 'single', url: single.url, contentType: 'video/mp4', video: true });
  });

  it('has_video === false is audio, whatever the content type says', () => {
    expect(playbackSources({ ...single, has_video: false })?.kind).toBe('single');
    expect((playbackSources({ ...single, has_video: false }) as { video: boolean }).video).toBe(false);
  });

  it('an audio content type is audio even if has_video is true or unknown', () => {
    for (const has_video of [true, null, undefined]) {
      const out = playbackSources({ ...single, has_video, content_type: 'audio/mp4' }) as { video: boolean };
      expect(out.video, String(has_video)).toBe(false);
    }
    expect((playbackSources({ ...single, content_type: 'audio/ogg' }) as { video: boolean }).video).toBe(false);
  });

  it('unknown has_video with a video content type or none is video', () => {
    expect((playbackSources({ ...single, has_video: null }) as { video: boolean }).video).toBe(true);
    expect((playbackSources({ ...single, has_video: undefined, content_type: undefined }) as { video: boolean }).video).toBe(true);
  });

  it('plays a recovered pair as split and needs both halves', () => {
    const split: R1RecordingPlayback = {
      state: 'partial',
      mode: 'split',
      video_url: 'https://r2.example.test/v?sig=1',
      audio_url: 'https://r2.example.test/a?sig=1',
    };
    expect(playbackSources(split)).toEqual({ kind: 'split', videoUrl: split.video_url, audioUrl: split.audio_url });
    expect(playbackSources({ ...split, audio_url: undefined })).toBeNull();
    expect(playbackSources({ ...split, video_url: '' })).toBeNull();
  });

  it('plays nothing for a state without a file, even if a URL is present', () => {
    for (const state of ['none', 'recording', 'processing', 'failed', 'deleted'] as const) {
      expect(playbackSources({ ...single, state }), state).toBeNull();
    }
    expect(playbackSources({ ...single, state: 'bogus' as never })).toBeNull();
    expect(playbackSources(null)).toBeNull();
    expect(playbackSources(undefined)).toBeNull();
  });

  it('plays nothing when the URL is missing or not a web/data URL', () => {
    expect(playbackSources({ ...single, url: undefined })).toBeNull();
    expect(playbackSources({ ...single, url: '' })).toBeNull();
    expect(playbackSources({ ...single, url: 'javascript:alert(1)' })).toBeNull();
    expect(playbackSources({ ...single, url: 'file:///etc/passwd' })).toBeNull();
    expect(playbackSources({ ...single, url: 42 as unknown as string })).toBeNull();
    expect(isSafeMediaUrl('data:audio/wav;base64,AAAA')).toBe(true);
    expect(isSafeMediaUrl('HTTPS://x.test/y')).toBe(true);
    expect(isSafeMediaUrl('blob:https://x.test/1')).toBe(false);
  });
});

describe('words for time', () => {
  it('clockText is m:ss', () => {
    expect(clockText(0)).toBe('0:00');
    expect(clockText(65.4)).toBe('1:05');
    expect(clockText(3599)).toBe('59:59');
    expect(clockText(-3)).toBe('0:00');
  });

  it('durationWords is "7m 3s" or "45s"', () => {
    expect(durationWords(45_000)).toBe('45s');
    expect(durationWords(423_000)).toBe('7m 3s');
    expect(durationWords(0)).toBe('0s');
    expect(durationWords(-5)).toBe('0s');
  });
});

describe('r1RecordingStateCopy: every state', () => {
  it('none', () => {
    expect(r1RecordingStateCopy({ state: 'none' })).toMatchObject({
      tag: 'No recording',
      detail: 'No recording was made for this attempt.',
      action: 'none',
    });
  });

  it('recording and processing', () => {
    expect(r1RecordingStateCopy({ state: 'recording' })).toMatchObject({
      tag: 'Recording',
      detail: 'In progress. It can be played a few minutes after the interview ends.',
      action: 'none',
    });
    expect(r1RecordingStateCopy({ state: 'processing' })).toMatchObject({
      tag: 'Processing',
      detail: 'The recording is being prepared. This usually takes a few minutes.',
      action: 'refresh',
    });
  });

  it('ready: facts, a Load action, no notice', () => {
    const copy = r1RecordingStateCopy(
      summary({ duration_ms: 423_000, retention_until: '2027-01-12T10:00:00.000Z', camera_off_ms: 80_000 }),
    );
    expect(copy).toMatchObject({ tag: 'Ready', tone: 'positive', notice: null, action: 'load' });
    expect(copy.facts[0]).toBe('Length 7m 3s');
    expect(copy.facts[1]).toMatch(/^Kept until .*2027/);
    expect(copy.facts[2]).toBe('Camera was off for 1m 20s');
  });

  it('ready: leaves out facts it does not have, and a camera-off blip under a second', () => {
    expect(r1RecordingStateCopy(summary()).facts).toEqual([]);
    expect(r1RecordingStateCopy(summary({ camera_off_ms: 999, duration_ms: 0 })).facts).toEqual([]);
    expect(r1RecordingStateCopy(summary({ retention_until: '' })).facts).toEqual([]);
  });

  it('failed: words by reason, never the code', () => {
    const words = {
      integrity: 'It failed an integrity check and is withheld.',
      oversize: 'The recording was too large to keep.',
      object_missing: 'The recording file is missing, so it is withheld.',
      crash_recovered: 'The recording was interrupted and nothing could be recovered.',
      capture_failed: 'Recording failed during the interview.',
    };
    for (const [reason, detail] of Object.entries(words)) {
      expect(r1RecordingStateCopy({ state: 'failed', reason })).toMatchObject({ tag: 'Unavailable', tone: 'negative', detail, action: 'none' });
    }
    expect(r1RecordingStateCopy({ state: 'failed', reason: 'something_new' }).detail).toBe('The recording is unavailable.');
    expect(r1RecordingStateCopy({ state: 'failed' }).detail).toBe('The recording is unavailable.');
  });

  it('deleted: date and reason, no claim about what else is kept', () => {
    expect(r1RecordingStateCopy({ state: 'deleted', reason: 'retention', deleted_at: '2027-01-12T10:00:00.000Z' }).detail).toMatch(
      /^This recording was deleted on .*2027 after the retention period\.$/,
    );
    expect(r1RecordingStateCopy({ state: 'deleted', reason: 'consent_withdrawn', deleted_at: '2027-01-12T10:00:00.000Z' }).detail).toMatch(
      /because consent was withdrawn\.$/,
    );
    expect(r1RecordingStateCopy({ state: 'deleted', reason: 'erasure' }).detail).toBe('This recording was deleted on request.');
    expect(r1RecordingStateCopy({ state: 'deleted' }).detail).toBe('This recording was deleted.');
    expect(r1RecordingStateCopy({ state: 'deleted', reason: 'revoked' }).detail).toBe('This recording was deleted.');
  });

  it('unknown state fails closed: a status line and a re-read, never a Load', () => {
    for (const state of ['revoked', '', undefined, 3]) {
      const copy = r1RecordingStateCopy({ state } as unknown as R1RecordingSummary);
      expect(copy, String(state)).toMatchObject({ tag: 'Status unknown', detail: 'Recording status unknown.', action: 'refresh' });
    }
    expect(r1RecordingStateCopy(null).action).toBe('refresh');
  });
});

describe('r1RecordingStateCopy: partial and ready notices by reason', () => {
  const partial = (over: Partial<R1RecordingSummary>) => r1RecordingStateCopy({ state: 'partial', ...over });

  it('audio_only_degraded names the moment video stopped', () => {
    expect(partial({ reason: 'audio_only_degraded', degraded_at_ms: 125_000 }).notice).toBe(
      'Video stopped at 2:05 to protect the interview; the rest is audio only.',
    );
    expect(partial({ reason: 'audio_only_degraded', degraded_at_ms: null }).notice).toBe(
      'Video stopped to protect the interview; the rest is audio only.',
    );
    expect(partial({ reason: 'audio_only_degraded' }).tag).toBe('Partial');
  });

  it('video_unavailable and crash_recovered', () => {
    expect(partial({ reason: 'video_unavailable' }).notice).toBe('The camera was not available, so this is an audio-only recording.');
    expect(partial({ reason: 'crash_recovered' }).notice).toBe('Recovered after an interruption; it may end early.');
  });

  it('any other reason, or none, still says part of it is missing', () => {
    expect(partial({ reason: 'brand_new' }).notice).toBe('Part of this recording is missing.');
    expect(partial({ reason: null }).notice).toBe('Part of this recording is missing.');
    expect(partial({}).notice).toBe('Part of this recording is missing.');
  });

  it('a ready recording with a reason shows it; without one shows nothing', () => {
    expect(r1RecordingStateCopy({ state: 'ready', reason: 'crash_recovered' }).notice).toBe('Recovered after an interruption; it may end early.');
    expect(r1RecordingStateCopy({ state: 'ready', reason: null }).notice).toBeNull();
  });

  it('a partial recording still has a Load action', () => {
    expect(partial({}).action).toBe('load');
  });
});

describe('error words', () => {
  it.each([
    [0, undefined, 'Could not load the recording. Try again.'],
    [403, 'access_denied', 'You do not have access to this recording.'],
    [403, 'Insufficient permissions', 'You do not have access to this recording.'],
    [404, 'not_found', 'This recording no longer exists.'],
    [429, '429 Too Many Requests', 'Too many requests. Try again in a moment.'],
    [500, 'internal', 'Could not load the recording. Try again.'],
    [503, 'r1_recording_unavailable', 'Could not load the recording. Try again.'],
    [400, 'invalid_id', 'Could not load the recording. Try again.'],
  ])('status %s code %s', (status, code, words) => {
    expect(r1RecordingErrorMessage(status, code)).toBe(words);
  });

  it('a code is enough when the status was lost on the way (a proxy rewriting it)', () => {
    expect(r1RecordingErrorMessage(502, 'access_denied')).toBe('You do not have access to this recording.');
    expect(r1RecordingErrorMessage(502, 'Insufficient permissions')).toBe('You do not have access to this recording.');
    expect(r1RecordingErrorMessage(502, 'not_found')).toBe('This recording no longer exists.');
    expect(r1RecordingErrorMessage(0, 'unknown_code')).toBe('Could not load the recording. Try again.');
  });

  it('never repeats the API code or a raw message', () => {
    for (const [status, code] of [[500, 'secret_internal_code'], [418, 'teapot']] as const) {
      expect(r1RecordingErrorMessage(status, code)).not.toContain(code);
    }
  });

  it('only a transient failure offers Try again', () => {
    expect(r1RecordingErrorRetryable(0)).toBe(true);
    expect(r1RecordingErrorRetryable(429)).toBe(true);
    expect(r1RecordingErrorRetryable(500)).toBe(true);
    expect(r1RecordingErrorRetryable(503, 'r1_recording_unavailable')).toBe(true);
    expect(r1RecordingErrorRetryable(403)).toBe(false);
    expect(r1RecordingErrorRetryable(404)).toBe(false);
    expect(r1RecordingErrorRetryable(200, 'access_denied')).toBe(false);
  });

  it('media errors', () => {
    expect(r1MediaErrorMessage(true)).toBe('This browser cannot play this recording.');
    expect(r1MediaErrorMessage(false)).toBe('The recording could not be played. Try again.');
  });
});

describe('attempt labels', () => {
  it('first counted attempt is counted, second counted is the retake, the rest are not counted', () => {
    expect(
      attemptLabels([
        { attempt_number: 1, counted: true },
        { attempt_number: 2, counted: true },
        { attempt_number: 3, counted: false },
      ]),
    ).toEqual(['Attempt 1 (counted)', 'Attempt 2 (retake)', 'Attempt 3 (not counted)']);
  });

  it('an uncounted first attempt does not make the next one a retake', () => {
    expect(
      attemptLabels([
        { attempt_number: 1, counted: false },
        { attempt_number: 2, counted: true },
      ]),
    ).toEqual(['Attempt 1 (not counted)', 'Attempt 2 (counted)']);
  });

  it('is empty for no attempts', () => {
    expect(attemptLabels([])).toEqual([]);
  });
});

describe('showsRecordingRow', () => {
  it('shows any recording in any state', () => {
    for (const state of ['recording', 'processing', 'ready', 'partial', 'failed', 'deleted'] as const) {
      expect(showsRecordingRow({ state }, false), state).toBe(true);
    }
  });

  it('shows "none" only once the round has completed', () => {
    expect(showsRecordingRow({ state: 'none' }, true)).toBe(true);
    expect(showsRecordingRow({ state: 'none' }, false)).toBe(false);
  });

  it('shows an unknown state (it says so) and nothing for no summary', () => {
    expect(showsRecordingRow({ state: 'weird' } as unknown as R1RecordingSummary, false)).toBe(true);
    expect(showsRecordingRow(null, true)).toBe(false);
    expect(showsRecordingRow(undefined, true)).toBe(false);
  });
});
