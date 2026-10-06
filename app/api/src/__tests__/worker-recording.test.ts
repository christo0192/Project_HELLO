/**
 * PR A — `prepareWorkerRecording`, the `RECORDING_PROVIDER=worker` twin of
 * `startPhoneAttemptRecording`, and the one property it must share with it:
 *
 *   NO UPLOAD URL MAY BE MINTED BEFORE THE CONSENT GATE ATTACHES.
 *
 * The gate is `attach_phone_attempt_recording` (0043), which refuses unless the
 * engagement is `in_call`. So every refusal the gate can answer with is
 * exercised here, and each asserts the SAME things: the presigned-PUT signer
 * was NEVER called, and the explicit `boundForUpload` flag is false (and there
 * is no `uploadUrl`). Both, deliberately — a flag that lied and a spy that was
 * never observed are two different bugs.
 *
 * The happy path proves the reuse: the SAME store methods run in the SAME order
 * (`listEngagementRecordings` → evidence bind → `attachAttemptRecording`), the synthetic
 * `EG_worker_` egress id is recorded and stamped, and an upload URL comes back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LEG_TIMING_AFTER_NOW_SLACK_MS,
  LEG_TIMING_BEFORE_ANSWER_SLACK_MS,
  LEG_TIMING_MAX_DURATION_MS,
  planAttemptLegTimingStamp,
  prepareWorkerRecording,
  workerRecordingEgressId,
  type AttemptLegTimingRow,
  type PrepareWorkerRecordingDeps,
  type WorkerLegTimingReport,
} from '../integrations/livekit-phone-dial/worker-recording.js';
import {
  phoneAttemptRecordingManifestKey,
  phoneAttemptRecordingObjectKey,
  type PhoneRecordingArtifact,
  type PhoneStores,
} from '../lib/phone-screening/index.js';

const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
const SESSION = '99999999-8888-4777-8666-555555555555';
const NOW = new Date('2026-09-01T05:30:00.000Z');

/** A shared call-order log, so ORDER is asserted rather than assumed. */
let order: string[];

beforeEach(() => {
  order = [];
});

function authoritativeArtifact(): PhoneRecordingArtifact {
  return {
    attemptId: OTHER_ATTEMPT,
    role: 'authoritative',
    objectKey: phoneAttemptRecordingObjectKey(OTHER_ATTEMPT),
    manifestKey: phoneAttemptRecordingManifestKey(OTHER_ATTEMPT),
    egressId: null,
    egressStatus: null,
  };
}

interface Harness {
  deps: PrepareWorkerRecordingDeps;
  list: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  stamp: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
  createUploadUrl: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  list?: unknown;
  attach?: unknown;
  stamp?: unknown;
  uploadUrl?: { uploadUrl: string } | null;
  stampThrows?: boolean;
} = {}): Harness {
  const list = vi.fn(async () => {
    order.push('list');
    return (opts.list ?? { status: 'ok', artifacts: [] }) as never;
  });
  const bind = vi.fn(async () => {
    order.push('bind');
    return { status: 'ok', bound: true } as never;
  });
  const attach = vi.fn(async () => {
    order.push('attach');
    return (opts.attach ?? { status: 'ok', duplicate: false }) as never;
  });
  const finalize = vi.fn(async () => {
    order.push('finalize');
    return { status: 'ok' } as never;
  });
  const stamp = vi.fn(async () => {
    order.push('stamp');
    if (opts.stampThrows) throw new Error('synthetic stamp failure');
    return (opts.stamp ?? { status: 'ok', duplicate: false }) as never;
  });
  const createUploadUrl = vi.fn(async () => {
    order.push('sign');
    return opts.uploadUrl === undefined
      ? { uploadUrl: 'https://storage.invalid/put/phone-object?token=abc' }
      : opts.uploadUrl;
  });

  const stores = {
    listEngagementRecordings: list,
    bindPhoneAttemptRecordingSession: bind,
    attachAttemptRecording: attach,
    finalizeAttemptRecording: finalize,
    stampSessionEgress: stamp,
  } as unknown as PhoneStores;

  return {
    deps: { stores, signer: { createUploadUrl } },
    list,
    attach,
    finalize,
    stamp,
    bind,
    createUploadUrl,
  };
}

const INPUT = {
  // 0105: this fixture is the CONSENTED prepare (the state that stamps).
  engagementState: 'in_call',
  engagementId: ENGAGEMENT,
  attemptId: ATTEMPT,
  sessionId: SESSION,
  now: NOW,
};

describe('prepareWorkerRecording — the consent gate governs the upload URL', () => {
  it('prepares: attaches the DERIVED keys, records the synthetic egress id, stamps, and returns an upload URL', async () => {
    const h = harness();
    const result = await prepareWorkerRecording(INPUT, h.deps);

    expect(result.status).toBe('prepared');
    expect(result.boundForUpload).toBe(true);
    expect(result.objectKey).toBe(phoneAttemptRecordingObjectKey(ATTEMPT));
    expect(result.manifestKey).toBe(phoneAttemptRecordingManifestKey(ATTEMPT));
    expect(result.uploadUrl).toBe('https://storage.invalid/put/phone-object?token=abc');
    expect(result.role).toBe('authoritative');
    expect(result.sessionStamped).toBe(true);

    // The attach carried EXACTLY the derived keys, the decided role, and the clock.
    expect(h.attach).toHaveBeenCalledWith({
      attemptId: ATTEMPT,
      objectKey: phoneAttemptRecordingObjectKey(ATTEMPT),
      manifestKey: phoneAttemptRecordingManifestKey(ATTEMPT),
      role: 'authoritative',
      now: NOW,
    });
    // The synthetic egress id is recorded on the attempt AND stamped on the session.
    const expectedEgressId = workerRecordingEgressId(ATTEMPT);
    expect(expectedEgressId).toMatch(/^EG_[A-Za-z0-9_-]{4,200}$/);
    expect(h.finalize).toHaveBeenCalledWith({
      attemptId: ATTEMPT,
      egressStatus: 'active',
      egressId: expectedEgressId,
      now: NOW,
    });
    expect(h.stamp).toHaveBeenCalledWith({
      sessionId: SESSION,
      attemptId: ATTEMPT,
      egressId: expectedEgressId,
      now: NOW,
    });
    // The gate ran BEFORE the URL was minted.
    expect(order).toEqual(['list', 'bind', 'attach', 'finalize', 'stamp', 'sign']);
  });

  it('is supplementary when an authoritative artifact already exists', async () => {
    const h = harness({ list: { status: 'ok', artifacts: [authoritativeArtifact()] } });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('prepared');
    expect(result.role).toBe('supplementary');
    expect(h.attach.mock.calls[0][0].role).toBe('supplementary');
  });

  // ── THE NEGATIVE PATHS: a refusal mints NO upload URL ────────────────
  it('refuses and mints nothing when the role is UNDECIDABLE (unreadable set)', async () => {
    const h = harness({ list: { status: 'error' } });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('refused');
    expect(result.refusal).toBe('role_undecidable');
    expect(result.boundForUpload).toBe(false);
    expect(result.uploadUrl).toBeUndefined();
    // Nothing attached, nothing stamped, and crucially NO url was minted.
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.createUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses and mints nothing when the ATTACH gate refuses (pre-disclosure / not in_call)', async () => {
    const h = harness({ attach: { status: 'disclosure_not_delivered', engagementState: 'dialing' } });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('refused');
    expect(result.refusal).toBe('disclosure_not_delivered');
    expect(result.boundForUpload).toBe(false);
    expect(result.uploadUrl).toBeUndefined();
    expect(h.createUploadUrl).not.toHaveBeenCalled();
    // The gate refused, so no egress id was recorded and no session was stamped.
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.stamp).not.toHaveBeenCalled();
  });

  it('refuses and mints nothing when the attach loses the authoritative race', async () => {
    const h = harness({ attach: { status: 'authoritative_exists' } });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('refused');
    expect(result.refusal).toBe('authoritative_exists');
    expect(result.boundForUpload).toBe(false);
    expect(result.uploadUrl).toBeUndefined();
    expect(h.createUploadUrl).not.toHaveBeenCalled();
  });

  it('a duplicate attach re-mints and stamps at consent without re-attaching', async () => {
    const h = harness({ attach: { status: 'ok', duplicate: true } });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('already_prepared');
    expect(result.boundForUpload).toBe(true);
    expect(result.uploadUrl).toBe('https://storage.invalid/put/phone-object?token=abc');
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.stamp).toHaveBeenCalledTimes(1);
    expect(h.createUploadUrl).toHaveBeenCalledTimes(1);
  });

  it('reports upload_url_failed WITHOUT an upload URL when the signer cannot mint one', async () => {
    const h = harness({ uploadUrl: null });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('upload_url_failed');
    expect(result.boundForUpload).toBe(false);
    expect(result.uploadUrl).toBeUndefined();
    // The binding still exists (attach + finalize ran) — the SAFE asymmetry:
    // a purge enumerates by binding, so an object never written is nothing to
    // purge; audio with no binding is impossible because the gate ran first.
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.finalize).toHaveBeenCalledTimes(1);
  });

  it('a failed stamp is best-effort: still prepared, but sessionStamped=false is surfaced', async () => {
    const h = harness({ stampThrows: true });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('prepared');
    expect(result.boundForUpload).toBe(true);
    expect(result.sessionStamped).toBe(false);
    expect(result.stampStatus).toBe('store_error');
    // A failed stamp does NOT stop the upload URL from being minted.
    expect(result.uploadUrl).toBe('https://storage.invalid/put/phone-object?token=abc');
  });
});

// ── 0105: the session pointer is stamped only at consent ──────────────────
describe('0105 — prepare before consent binds the attempt but leaves the SESSION slot alone', () => {
  it('a `dialing` engagement is bound and minted, and NOT stamped', async () => {
    const h = harness();
    const result = await prepareWorkerRecording({ ...INPUT, engagementState: 'dialing' }, h.deps);
    expect(result.status).toBe('prepared');
    expect(result.boundForUpload).toBe(true);
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.stamp).not.toHaveBeenCalled();
    expect(result.sessionStamped).not.toBe(true);
    expect(result.stampStatus).toBe('deferred_until_consent');
  });

  it('an UNKNOWN state is treated as pre-consent — never stamp on a guess', async () => {
    const h = harness();
    const result = await prepareWorkerRecording({ ...INPUT, engagementState: null }, h.deps);
    expect(result.status).toBe('prepared');
    expect(h.stamp).not.toHaveBeenCalled();
  });

  it('`in_call` stamps, exactly as before 0105', async () => {
    const h = harness();
    const result = await prepareWorkerRecording({ ...INPUT, engagementState: 'in_call' }, h.deps);
    expect(result.status).toBe('prepared');
    expect(h.stamp).toHaveBeenCalledTimes(1);
  });

  it('reuses its own authoritative role on consent retry even when another attempt is authoritative', async () => {
    const h = harness({
      list: {
        status: 'ok',
        artifacts: [
          authoritativeArtifact(),
          {
            attemptId: ATTEMPT,
            role: 'authoritative',
            objectKey: phoneAttemptRecordingObjectKey(ATTEMPT),
            manifestKey: phoneAttemptRecordingManifestKey(ATTEMPT),
            egressId: workerRecordingEgressId(ATTEMPT),
            egressStatus: 'active',
          },
        ],
      },
      attach: { status: 'ok', duplicate: true },
    });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('already_prepared');
    expect(h.attach.mock.calls[0][0].role).toBe('authoritative');
    expect(h.stamp).toHaveBeenCalledTimes(1);
  });
});

// ── M013 S02 (T04): the leg-timing stamp rule ─────────────────────────────
//
// Synthetic timings shaped like 9f60523d leg 2 (answered, dropped ~19 s later,
// reclaimed ~6 min after that). No real call data.

describe('planAttemptLegTimingStamp — sanity window, earliest end, first write', () => {
  const ANSWERED = '2026-10-05T03:34:49.600Z';
  const ADMITTED = '2026-10-05T03:34:30.000Z';
  const REC_START = Date.parse('2026-10-05T03:34:50.650Z');
  const LEG_END = Date.parse('2026-10-05T03:35:08.300Z');
  const AT = new Date('2026-10-05T03:35:10.000Z');

  function row(over: Partial<AttemptLegTimingRow> = {}): AttemptLegTimingRow {
    return {
      answeredAt: ANSWERED,
      admittedAt: ADMITTED,
      endedAt: null,
      observedEndedAt: null,
      recordingStartedAtMs: null,
      recordingDurationMs: null,
      recordingTailFlushed: null,
      ...over,
    };
  }
  const report: WorkerLegTimingReport = {
    recordingStartedAtMs: REC_START,
    legEndedAtMs: LEG_END,
    durationMs: 17_650,
    tailFlushed: true,
  };

  it('stamps every column on a fresh attempt', () => {
    expect(planAttemptLegTimingStamp(row(), report, AT)).toEqual({
      patch: {
        observed_ended_at: '2026-10-05T03:35:08.300Z',
        recording_started_at_ms: REC_START,
        recording_duration_ms: 17_650,
        recording_tail_flushed: true,
      },
      dropped: [],
    });
  });

  it('bounds the observed end by the ledger end: observed = min(leg end, ended_at)', () => {
    // Reconciled earlier than the worker's report (clock skew): the ledger wins.
    const earlier = planAttemptLegTimingStamp(row({ endedAt: '2026-10-05T03:35:07.000Z' }), report, AT);
    expect(earlier.patch.observed_ended_at).toBe('2026-10-05T03:35:07.000Z');
    // Reclaimed 6 min later: the worker's observed end wins.
    const reclaimed = planAttemptLegTimingStamp(row({ endedAt: '2026-10-05T03:40:57.500Z' }), report, AT);
    expect(reclaimed.patch.observed_ended_at).toBe('2026-10-05T03:35:08.300Z');
  });

  it('is idempotent: a second report with a LATER leg end does not move observed_ended_at', () => {
    const stamped = row({
      observedEndedAt: '2026-10-05T03:35:08.300Z',
      recordingStartedAtMs: REC_START,
      recordingDurationMs: 17_650,
      recordingTailFlushed: true,
    });
    const later = planAttemptLegTimingStamp(stamped, {
      recordingStartedAtMs: REC_START + 900,
      legEndedAtMs: LEG_END + 2_500,
      durationMs: 20_000,
      tailFlushed: false,
    }, AT);
    expect(later).toEqual({ patch: {}, dropped: [] });
  });

  it('an EARLIER observed end replaces a later one (earliest wins); the rest stays first-write', () => {
    const stamped = row({
      observedEndedAt: '2026-10-05T03:35:10.000Z',
      recordingStartedAtMs: REC_START,
      recordingDurationMs: 17_650,
      recordingTailFlushed: false,
    });
    expect(planAttemptLegTimingStamp(stamped, report, AT)).toEqual({
      patch: { observed_ended_at: '2026-10-05T03:35:08.300Z' },
      dropped: [],
    });
  });

  it('drops (never rejects) epoch values outside [answered_at − 30 s, now + 60 s]', () => {
    const answeredMs = Date.parse(ANSWERED);
    const tooEarly = planAttemptLegTimingStamp(row(), {
      ...report, recordingStartedAtMs: answeredMs - 30_001, legEndedAtMs: answeredMs - 31_000,
    }, AT);
    expect(tooEarly.patch).toEqual({ recording_duration_ms: 17_650, recording_tail_flushed: true });
    expect(tooEarly.dropped).toEqual(['recording_started_at_out_of_window', 'leg_ended_at_out_of_window']);

    const tooLate = planAttemptLegTimingStamp(row(), {
      ...report, legEndedAtMs: AT.getTime() + 60_001,
    }, AT);
    expect(tooLate.patch.observed_ended_at).toBeUndefined();
    expect(tooLate.dropped).toEqual(['leg_ended_at_out_of_window']);
  });

  it('accepts the exact window edges (30 s skew before answer, 60 s after now)', () => {
    const answeredMs = Date.parse(ANSWERED);
    const edge = planAttemptLegTimingStamp(row(), {
      recordingStartedAtMs: answeredMs - 30_000, legEndedAtMs: AT.getTime() + 60_000,
    }, AT);
    expect(edge.dropped).toEqual([]);
    expect(edge.patch.recording_started_at_ms).toBe(answeredMs - 30_000);
    expect(edge.patch.observed_ended_at).toBe(new Date(AT.getTime() + 60_000).toISOString());
  });

  it('falls back to admitted_at when the leg has no answered_at, and drops epochs with no anchor at all', () => {
    const viaAdmitted = planAttemptLegTimingStamp(row({ answeredAt: null }), report, AT);
    expect(viaAdmitted.dropped).toEqual([]);
    expect(viaAdmitted.patch.observed_ended_at).toBe('2026-10-05T03:35:08.300Z');

    const noAnchor = planAttemptLegTimingStamp(row({ answeredAt: null, admittedAt: null }), report, AT);
    expect(noAnchor.dropped).toEqual(['no_answer_anchor']);
    expect(noAnchor.patch).toEqual({ recording_duration_ms: 17_650, recording_tail_flushed: true });
  });

  it('keeps the duration inside the 0115 CHECK (1 ms .. 24 h)', () => {
    for (const bad of [0, -5, LEG_TIMING_MAX_DURATION_MS + 1]) {
      const plan = planAttemptLegTimingStamp(row(), { durationMs: bad }, AT);
      expect(plan.patch).toEqual({});
      expect(plan.dropped).toEqual(['duration_out_of_range']);
    }
    expect(planAttemptLegTimingStamp(row(), { durationMs: LEG_TIMING_MAX_DURATION_MS }, AT).patch)
      .toEqual({ recording_duration_ms: LEG_TIMING_MAX_DURATION_MS });
  });

  it('an empty or all-null report plans nothing', () => {
    expect(planAttemptLegTimingStamp(row(), {}, AT)).toEqual({ patch: {}, dropped: [] });
    expect(planAttemptLegTimingStamp(row(), {
      recordingStartedAtMs: null, legEndedAtMs: null, durationMs: null, tailFlushed: null,
    }, AT)).toEqual({ patch: {}, dropped: [] });
  });

  it('pins the window constants the route documents', () => {
    expect(LEG_TIMING_BEFORE_ANSWER_SLACK_MS).toBe(30_000);
    expect(LEG_TIMING_AFTER_NOW_SLACK_MS).toBe(60_000);
    expect(LEG_TIMING_MAX_DURATION_MS).toBe(86_400_000);
  });
});
