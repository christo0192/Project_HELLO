/**
 * PR A — the two WORKER-INBAND endpoints on `createPhoneWorkerRouter`:
 *   POST /recording/prepare   POST /recording/complete
 *
 * Two properties carry this file:
 *
 * 1. ON THE EGRESS PROVIDER THE ENDPOINTS DO NOT EXIST. `recordingProvider`
 *    defaults to `env.recordingProvider` ('egress'); on egress both routes 404
 *    and touch NOTHING — the egress recording path is byte-for-byte unaffected.
 *
 * 2. THE CONSENT GATE STILL GOVERNS. On the worker provider, `prepare` runs the
 *    SAME attach gate the egress path uses; a refusal returns NO upload_url and
 *    binds nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createPhoneWorkerRouter,
  egressRecordingEnabled,
  createSupabaseUploadSigner,
  type SignedUploadUrlStorage,
} from '../routes/phone-worker.js';
import type { PhoneStores } from '../lib/phone-screening/index.js';
import type { WorkerRecordingUploadSigner } from '../integrations/livekit-phone-dial/worker-recording.js';

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '99999999-8888-4777-8666-555555555555';
const SECRET = 'phone-worker-secret-0123456789abcdefghij';
const NOW = new Date('2026-10-05T03:36:00.000Z');

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.WORKER_CONTEXT_SECRET;
  process.env.WORKER_CONTEXT_SECRET = SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.WORKER_CONTEXT_SECRET;
  else process.env.WORKER_CONTEXT_SECRET = savedSecret;
});

const ENABLED = { PHONE_SCREENING_ENABLED: 'true' } as NodeJS.ProcessEnv;

interface BuildOpts {
  recordingProvider?: 'egress' | 'worker';
  withSigner?: boolean;
  uploadUrl?: { uploadUrl: string } | null;
  attachStatus?: string;
  attachDuplicate?: boolean;
  finalizeStatus?: 'ready' | 'fallback_required' | 'pending';
  finalizeAttemptStatus?: 'ready' | 'fallback_required' | 'pending';
  finalizeThrows?: boolean;
  markFailedStatus?: 'failed_latched' | 'already_linked' | 'not_worker_inband' | 'attempt_mismatch' | 'session_not_found' | 'latch_failed';
  markFailedThrows?: boolean;
  /** When set, wires a resolveEngagement dep so an omitted engagement_id can be
   *  resolved server-side (PR A in-worker recorder path). */
  resolveEngagement?: ((attemptId: string) => Promise<{
    engagementId: string;
    engagementState: string;
    version: number;
    sessionId?: string;
  } | null>) | undefined;
  resolveAttemptRecordingSession?: ((attemptId: string) => Promise<string | null>) | undefined;
  /** M013 S02 (T04): the leg-timing stamp seam. */
  stampAttemptLegTiming?: ReturnType<typeof vi.fn>;
}

function build(opts: BuildOpts = {}) {
  const list = vi.fn(async () => ({ status: 'ok', artifacts: [] }));
  const bindPhoneAttemptRecordingSession = vi.fn(async () => ({ status: 'ok', bound: true }));
  const attach = vi.fn(async () => ({
    status: opts.attachStatus ?? 'ok',
    duplicate: opts.attachDuplicate ?? false,
  }));
  const storeFinalizeAttemptRecording = vi.fn(async (_input: { egressId?: string | null }) => ({ status: 'ok' }));
  const finalizeAttemptRecording = vi.fn(async (_attemptId: string, _sessionId: string) => opts.finalizeAttemptStatus ?? opts.finalizeStatus ?? 'ready');
  const stampSessionEgress = vi.fn(async (_input: { egressId: string }) => ({ status: 'ok', duplicate: false }));

  const stores = {
    listEngagementRecordings: list,
    bindPhoneAttemptRecordingSession,
    attachAttemptRecording: attach,
    finalizeAttemptRecording: storeFinalizeAttemptRecording,
    stampSessionEgress,
  } as unknown as PhoneStores;

  const createUploadUrl = vi.fn(async () =>
    opts.uploadUrl === undefined
      ? { uploadUrl: 'https://storage.invalid/put/obj?token=xyz' }
      : opts.uploadUrl,
  );
  const uploadSigner: WorkerRecordingUploadSigner = { createUploadUrl };

  const finalizeRecording = vi.fn(async () => {
    if (opts.finalizeThrows) throw new Error('synthetic finalize failure');
    return opts.finalizeStatus ?? 'ready';
  });

  const markRecordingFailed = vi.fn(async () => {
    if (opts.markFailedThrows) throw new Error('synthetic latch failure');
    return opts.markFailedStatus ?? 'failed_latched';
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/internal/phone-worker',
    createPhoneWorkerRouter({
      stores,
      configSource: ENABLED,
      recordingProvider: opts.recordingProvider ?? 'egress',
      uploadSigner: opts.withSigner === false ? undefined : uploadSigner,
      finalizeRecording,
      finalizeAttemptRecording,
      markRecordingFailed,
      resolveEngagement: opts.resolveEngagement,
      resolveAttemptRecordingSession: opts.resolveAttemptRecordingSession,
      stampAttemptLegTiming: opts.stampAttemptLegTiming as never,
      now: () => NOW,
    }),
  );

  return { app, list, attach, finalizeAttemptRecording, storeFinalizeAttemptRecording, stampSessionEgress, bindPhoneAttemptRecordingSession, createUploadUrl, finalizeRecording, markRecordingFailed };
}

function authed(app: express.Express, path: string, body: object) {
  return request(app).post(path).set('Authorization', `Bearer ${SECRET}`).send(body);
}

const PREPARE = '/api/internal/phone-worker/recording/prepare';
const COMPLETE = '/api/internal/phone-worker/recording/complete';

const PREPARE_BODY = { attempt_id: ATTEMPT, session_id: SESSION, engagement_id: ENGAGEMENT };
const COMPLETE_BODY = {
  attempt_id: ATTEMPT,
  session_id: SESSION,
  sha256: 'a'.repeat(64),
  size_bytes: 12345,
  duration_ms: 60000,
};

describe('provider=egress leaves the worker endpoints INERT', () => {
  it('prepare 404s and touches no store or signer', async () => {
    const h = build({ recordingProvider: 'egress' });
    const res = await authed(h.app, PREPARE, PREPARE_BODY);
    expect(res.status).toBe(404);
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.createUploadUrl).not.toHaveBeenCalled();
  });

  it('complete 404s and never invokes the finalizer', async () => {
    const h = build({ recordingProvider: 'egress' });
    const res = await authed(h.app, COMPLETE, COMPLETE_BODY);
    expect(res.status).toBe(404);
    expect(h.finalizeRecording).not.toHaveBeenCalled();
  });

  it('the default provider (no override) is egress — prepare 404s', async () => {
    // No recordingProvider override AND no signer: falls back to env.recordingProvider,
    // which is 'egress' by default in the test environment.
    const app = express();
    app.use(express.json());
    app.use(
      '/api/internal/phone-worker',
      createPhoneWorkerRouter({
        stores: {
          listEngagementRecordings: vi.fn(),
          attachAttemptRecording: vi.fn(),
        } as unknown as PhoneStores,
        configSource: ENABLED,
      }),
    );
    const res = await authed(app, PREPARE, PREPARE_BODY);
    expect(res.status).toBe(404);
  });
});

describe('provider=worker prepare — reuses the consent gate', () => {
  it('returns an upload_url + object_key and stamps the synthetic egress id', async () => {
    const h = build({ recordingProvider: 'worker' });
    const res = await authed(h.app, PREPARE, PREPARE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('prepared');
    expect(res.body.object_key).toBe(`phone-${ATTEMPT}-egress.mp3`);
    expect(res.body.upload_url).toBe('https://storage.invalid/put/obj?token=xyz');
    // The SAME consent gate ran.
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.attach).toHaveBeenCalledTimes(1);
    // Synthetic egress id recorded on the ATTEMPT...
    expect(h.storeFinalizeAttemptRecording.mock.calls[0][0].egressId).toBe(`EG_worker_${ATTEMPT}`);
    // ...but the SESSION is NOT stamped: this prepare carries no engagement
    // state (no resolver wired), which 0105 treats as pre-consent. Sessions
    // are reused across attempts, so a pre-consent clip must not claim the
    // session's recording slot — the consent-time prepare, at `in_call`,
    // stamps it. See `worker-recording.test.ts` for the state-driven halves.
    expect(h.stampSessionEgress).not.toHaveBeenCalled();
  });

  it('a REFUSED attach yields NO upload_url and mints nothing', async () => {
    const h = build({ recordingProvider: 'worker', attachStatus: 'disclosure_not_delivered' });
    const res = await authed(h.app, PREPARE, PREPARE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('refused');
    expect(res.body.reason).toBe('disclosure_not_delivered');
    expect(res.body.upload_url).toBeUndefined();
    expect(h.createUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses 503 recording_unavailable when no signer is wired', async () => {
    const h = build({ recordingProvider: 'worker', withSigner: false });
    const res = await authed(h.app, PREPARE, PREPARE_BODY);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('recording_unavailable');
    // The gate is not even consulted — nothing is bound.
    expect(h.attach).not.toHaveBeenCalled();
  });

  it('rejects a malformed body with 400', async () => {
    const h = build({ recordingProvider: 'worker' });
    const res = await authed(h.app, PREPARE, { attempt_id: 'not-a-uuid', session_id: SESSION, engagement_id: ENGAGEMENT });
    expect(res.status).toBe(400);
    expect(h.attach).not.toHaveBeenCalled();
  });

  it('requires worker auth', async () => {
    const h = build({ recordingProvider: 'worker' });
    const res = await request(h.app).post(PREPARE).send(PREPARE_BODY);
    expect(res.status).toBe(401);
  });

  it('resolves engagement_id server-side when the worker omits it', async () => {
    // PR A: the in-worker recorder has no engagement id in scope, so it omits
    // the field and the server derives it from the attempt via resolveEngagement.
    const resolveEngagement = vi.fn(async () => ({
      engagementId: ENGAGEMENT,
      engagementState: 'in_call',
      version: 1,
    }));
    const h = build({ recordingProvider: 'worker', resolveEngagement });
    const res = await authed(h.app, PREPARE, { attempt_id: ATTEMPT, session_id: SESSION });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('prepared');
    expect(res.body.object_key).toBe(`phone-${ATTEMPT}-egress.mp3`);
    expect(resolveEngagement).toHaveBeenCalledWith(ATTEMPT);
    // The consent gate still ran with the server-resolved engagement.
    expect(h.attach).toHaveBeenCalledTimes(1);
  });

  it('fails closed with unknown_attempt when engagement_id is omitted and unresolvable', async () => {
    // No resolver wired ⇒ an omitted engagement id cannot be derived; bind
    // nothing and say so truthfully rather than fabricate an id.
    const h = build({ recordingProvider: 'worker' });
    const res = await authed(h.app, PREPARE, { attempt_id: ATTEMPT, session_id: SESSION });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('unknown_attempt');
    expect(res.body.upload_url).toBeUndefined();
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.createUploadUrl).not.toHaveBeenCalled();
  });
});

describe('provider=worker complete — drives the finalizer worker branch', () => {
  it('ready ⇒ ok:true', async () => {
    const h = build({ recordingProvider: 'worker', finalizeStatus: 'ready' });
    const res = await authed(h.app, COMPLETE, COMPLETE_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ready', session_status: 'ready' });
    expect(h.finalizeRecording).toHaveBeenCalledWith(SESSION);
  });

  it('pending (bounded deferral) ⇒ ok:false, forwarded truthfully', async () => {
    const h = build({ recordingProvider: 'worker', finalizeStatus: 'pending' });
    const res = await authed(h.app, COMPLETE, COMPLETE_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, status: 'pending' });
  });

  it('fallback_required (latched) ⇒ ok:false', async () => {
    const h = build({ recordingProvider: 'worker', finalizeStatus: 'fallback_required' });
    const res = await authed(h.app, COMPLETE, COMPLETE_BODY);
    expect(res.body).toEqual({ ok: false, status: 'fallback_required' });
  });

  it('keeps a gate clip ready while truthfully reporting that no reusable session slot was stamped', async () => {
    const h = build({ recordingProvider: 'worker', finalizeAttemptStatus: 'ready', finalizeStatus: 'fallback_required' });
    const res = await authed(h.app, COMPLETE, COMPLETE_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ready', session_status: 'fallback_required' });
    expect(h.finalizeAttemptRecording).toHaveBeenCalledTimes(1);
    expect(h.finalizeRecording).toHaveBeenCalledWith(SESSION);
  });

  it('a finalizer throw is a sanitized 500', async () => {
    const h = build({ recordingProvider: 'worker', finalizeThrows: true });
    const res = await authed(h.app, COMPLETE, COMPLETE_BODY);
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('session_recording_finalize_error');
  });

  it('rejects a malformed sha256 with 400', async () => {
    const h = build({ recordingProvider: 'worker' });
    const res = await authed(h.app, COMPLETE, { ...COMPLETE_BODY, sha256: 'tooshort' });
    expect(res.status).toBe(400);
    expect(h.finalizeRecording).not.toHaveBeenCalled();
  });
});

describe('M013 S02 (T04) complete — the leg timing is stamped on the attempt', () => {
  // Synthetic timings shaped like 9f60523d leg 2 (no real call data).
  const TIMED_BODY = {
    ...COMPLETE_BODY,
    duration_ms: 17_970,
    recording_started_at_ms: Date.parse('2026-10-05T03:34:50.650Z'),
    leg_ended_at_ms: Date.parse('2026-10-05T03:35:08.300Z'),
    tail_flushed: true,
  };

  function stampSpy(order?: string[], result: { status: string; dropped: string[] } = { status: 'stamped', dropped: [] }) {
    return vi.fn(async (_input: { report: Record<string, unknown> }) => {
      order?.push('stamp');
      return result;
    });
  }

  it('accepts the T02 body and stamps it BEFORE the finalize, with the report mapped field by field', async () => {
    const order: string[] = [];
    const stamp = stampSpy(order);
    const h = build({ recordingProvider: 'worker', stampAttemptLegTiming: stamp });
    h.finalizeAttemptRecording.mockImplementation(async () => {
      order.push('finalize_attempt');
      return 'ready';
    });
    const res = await authed(h.app, COMPLETE, TIMED_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ready', session_status: 'ready' });
    expect(order).toEqual(['stamp', 'finalize_attempt']);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(stamp).toHaveBeenCalledWith({
      attemptId: ATTEMPT,
      sessionId: SESSION,
      report: {
        recordingStartedAtMs: TIMED_BODY.recording_started_at_ms,
        legEndedAtMs: TIMED_BODY.leg_ended_at_ms,
        durationMs: 17_970,
        tailFlushed: true,
      },
      now: NOW,
    });
  });

  it('a LEGACY body (no new field) still works and stamps nothing', async () => {
    const stamp = stampSpy();
    const h = build({ recordingProvider: 'worker', stampAttemptLegTiming: stamp });
    const res = await authed(h.app, COMPLETE, COMPLETE_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ready', session_status: 'ready' });
    // A legacy worker's duration_ms is a wall-clock span, not the audio length.
    expect(stamp).not.toHaveBeenCalled();
  });

  it('tail_flushed=false alone marks a T02 body and is stamped', async () => {
    const stamp = stampSpy();
    const h = build({ recordingProvider: 'worker', stampAttemptLegTiming: stamp });
    await authed(h.app, COMPLETE, { ...COMPLETE_BODY, tail_flushed: false });
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(stamp.mock.calls[0][0].report).toEqual({
      recordingStartedAtMs: null, legEndedAtMs: null, durationMs: 60000, tailFlushed: false,
    });
  });

  it('nulls for every new field are accepted and stamp nothing', async () => {
    const stamp = stampSpy();
    const h = build({ recordingProvider: 'worker', stampAttemptLegTiming: stamp });
    const res = await authed(h.app, COMPLETE, {
      ...COMPLETE_BODY, recording_started_at_ms: null, leg_ended_at_ms: null, tail_flushed: null,
    });
    expect(res.status).toBe(200);
    expect(stamp).not.toHaveBeenCalled();
  });

  for (const status of ['pending', 'fallback_required'] as const) {
    it(`the timing is still stamped when the attempt finalize returns ${status}`, async () => {
      const stamp = stampSpy();
      const h = build({ recordingProvider: 'worker', finalizeAttemptStatus: status, stampAttemptLegTiming: stamp });
      const res = await authed(h.app, COMPLETE, TIMED_BODY);
      expect(res.body).toEqual({ ok: false, status });
      expect(stamp).toHaveBeenCalledTimes(1);
    });
  }

  it('the timing is still stamped on the 503 session_recording_pending path', async () => {
    const stamp = stampSpy();
    const h = build({
      recordingProvider: 'worker', finalizeAttemptStatus: 'ready', finalizeStatus: 'pending',
      stampAttemptLegTiming: stamp,
    });
    const res = await authed(h.app, COMPLETE, TIMED_BODY);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('session_recording_pending');
    expect(stamp).toHaveBeenCalledTimes(1);
  });

  it('a stamp that THROWS never blocks the completion, and logs only a bounded code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stamp = vi.fn(async () => { throw new Error(`boom ${ATTEMPT}`); });
      const h = build({ recordingProvider: 'worker', stampAttemptLegTiming: stamp });
      const res = await authed(h.app, COMPLETE, TIMED_BODY);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, status: 'ready', session_status: 'ready' });
      expect(h.finalizeAttemptRecording).toHaveBeenCalledTimes(1);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('recording_complete_timing'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).error_category).toBe('stamp:error');
      expect(lines[0]).not.toContain(ATTEMPT);
      expect(lines[0]).not.toContain(SESSION);
    } finally {
      warn.mockRestore();
    }
  });

  it('a dropped value and a non-stamped status are logged as bounded codes, never values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const stamp = stampSpy(undefined, { status: 'attempt_mismatch', dropped: ['leg_ended_at_out_of_window'] });
      const h = build({ recordingProvider: 'worker', stampAttemptLegTiming: stamp });
      const res = await authed(h.app, COMPLETE, TIMED_BODY);
      const info = out.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('recording_complete_timing'));
      out.mockRestore();
      expect(res.status).toBe(200);
      const warned = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('recording_complete_timing'));
      expect(info.map((l) => JSON.parse(l).error_category)).toEqual(['dropped:leg_ended_at_out_of_window']);
      expect(warned.map((l) => JSON.parse(l).error_category)).toEqual(['stamp:attempt_mismatch']);
      for (const line of [...info, ...warned]) {
        expect(line).not.toContain(String(TIMED_BODY.leg_ended_at_ms));
        expect(line).not.toContain(ATTEMPT);
      }
    } finally {
      out.mockRestore();
      warn.mockRestore();
    }
  });

  it('keeps the schema strict: a wrong type or an unknown field is a 400 and nothing is stamped', async () => {
    const stamp = stampSpy();
    const h = build({ recordingProvider: 'worker', stampAttemptLegTiming: stamp });
    for (const bad of [
      { ...TIMED_BODY, tail_flushed: 'yes' },
      { ...TIMED_BODY, leg_ended_at_ms: 1.5 },
      { ...TIMED_BODY, recording_started_at_ms: -1 },
      { ...TIMED_BODY, leg_ended_at_ms: 4_102_444_800_000 },
      { ...TIMED_BODY, leg_end_source: 'sip_left' },
    ]) {
      const res = await authed(h.app, COMPLETE, bad);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, status: 'invalid_request' });
    }
    expect(stamp).not.toHaveBeenCalled();
    expect(h.finalizeAttemptRecording).not.toHaveBeenCalled();
  });

  it('on the egress provider the route 404s and stamps nothing', async () => {
    const stamp = stampSpy();
    const h = build({ recordingProvider: 'egress', stampAttemptLegTiming: stamp });
    const res = await authed(h.app, COMPLETE, TIMED_BODY);
    expect(res.status).toBe(404);
    expect(stamp).not.toHaveBeenCalled();
  });
});

describe('provider=worker failed — latches a permanently lost recording', () => {
  // Live 2026-09-03 (EG_worker_a6cc612d): the worker's upload failed silently,
  // nothing told the server, and the finalizer retried a never-uploaded key to
  // exhaustion while the dashboard said "Recording is still processing". The
  // worker now reports the permanent loss and the server latches the session.
  const FAILED = '/api/internal/phone-worker/recording/failed';
  const FAILED_BODY = { attempt_id: ATTEMPT, session_id: SESSION, reason: 'upload_failed' };

  it('latches ⇒ ok:true, and the latch dep receives the session', async () => {
    const h = build({ recordingProvider: 'worker' });
    const res = await authed(h.app, FAILED, FAILED_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'failed_latched' });
    expect(h.markRecordingFailed).toHaveBeenCalledWith(SESSION, ATTEMPT);
  });

  it('accepts a gate-death failure without a consent session_id and resolves the evidence parent', async () => {
    const resolveAttemptRecordingSession = vi.fn(async () => SESSION);
    const h = build({ recordingProvider: 'worker', resolveAttemptRecordingSession });
    const res = await authed(h.app, FAILED, { attempt_id: ATTEMPT, reason: 'upload_failed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'failed_latched' });
    expect(resolveAttemptRecordingSession).toHaveBeenCalledWith(ATTEMPT);
    expect(h.markRecordingFailed).toHaveBeenCalledWith(SESSION, ATTEMPT);
  });

  it('an already-linked recording is not clobbered ⇒ ok:false, truthful status', async () => {
    const h = build({ recordingProvider: 'worker', markFailedStatus: 'already_linked' });
    const res = await authed(h.app, FAILED, FAILED_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, status: 'already_linked' });
  });

  it('404s on the egress provider — the endpoint does not exist there', async () => {
    const h = build({ recordingProvider: 'egress' });
    const res = await authed(h.app, FAILED, FAILED_BODY);
    expect(res.status).toBe(404);
    expect(h.markRecordingFailed).not.toHaveBeenCalled();
  });

  it('rejects an unbounded reason with 400', async () => {
    const h = build({ recordingProvider: 'worker' });
    const res = await authed(h.app, FAILED, { ...FAILED_BODY, reason: 'X'.repeat(65) });
    expect(res.status).toBe(400);
    expect(h.markRecordingFailed).not.toHaveBeenCalled();
  });

  it('requires worker auth', async () => {
    const h = build({ recordingProvider: 'worker' });
    const res = await request(h.app).post(FAILED).send(FAILED_BODY);
    expect(res.status).toBe(401);
    expect(h.markRecordingFailed).not.toHaveBeenCalled();
  });

  it('a latch throw is a sanitized 500', async () => {
    const h = build({ recordingProvider: 'worker', markFailedThrows: true });
    const res = await authed(h.app, FAILED, FAILED_BODY);
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('phone_recording_failed_error');
  });
});

describe('createSupabaseUploadSigner — the v115 upsert mint', () => {
  const KEY = 'phone-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-egress.mp3';

  it('mints the signed upload URL with upsert:true so the OGG fallback/retry can OVERWRITE', async () => {
    // THE FIX. Before v115 the mint was insert-only, so the OGG fallback (or any
    // retry) re-PUTing the same key 409'd and NOTHING landed. The signer must
    // pass `{ upsert: true }` so the presigned PUT overwrites instead.
    let seenOptions: { upsert?: boolean } | undefined;
    const storage: SignedUploadUrlStorage = {
      async createSignedUploadUrl(_path, options) {
        seenOptions = options;
        return { data: { signedUrl: 'https://storage.test/upload/sign/x?token=t' }, error: null };
      },
    };
    const signer = createSupabaseUploadSigner(storage);
    const res = await signer.createUploadUrl(KEY);
    expect(res).toEqual({ uploadUrl: 'https://storage.test/upload/sign/x?token=t' });
    // The load-bearing assertion: upsert was requested.
    expect(seenOptions).toEqual({ upsert: true });
  });

  it('an insert-only mock (rejects unless upsert) now succeeds because upsert is passed', async () => {
    // Models Supabase's insert-only behavior: the mint refuses unless upsert is
    // set. This mock would have returned an error for the pre-fix (no-options)
    // call; the fixed signer passes upsert:true and gets a URL.
    const storage: SignedUploadUrlStorage = {
      async createSignedUploadUrl(_path, options) {
        if (options?.upsert !== true) {
          return { data: null, error: { message: 'Duplicate' } };
        }
        return { data: { signedUrl: 'https://storage.test/upload/sign/x?token=t' }, error: null };
      },
    };
    const signer = createSupabaseUploadSigner(storage);
    expect(await signer.createUploadUrl(KEY)).toEqual({
      uploadUrl: 'https://storage.test/upload/sign/x?token=t',
    });
  });

  it('returns null (never throws at the worker) on an error, a missing URL, or a throw', async () => {
    const errored = createSupabaseUploadSigner({
      async createSignedUploadUrl() {
        return { data: null, error: { message: 'boom' } };
      },
    });
    expect(await errored.createUploadUrl(KEY)).toBeNull();

    const noUrl = createSupabaseUploadSigner({
      async createSignedUploadUrl() {
        return { data: null, error: null };
      },
    });
    expect(await noUrl.createUploadUrl(KEY)).toBeNull();

    const threw = createSupabaseUploadSigner({
      async createSignedUploadUrl() {
        throw new Error('driver down');
      },
    });
    expect(await threw.createUploadUrl(KEY)).toBeNull();
  });
});

describe('egressRecordingEnabled — no double-record on the worker provider', () => {
  it('arms egress only on the egress provider with storage configured', () => {
    // worker provider: egress MUST be off even though storage is configured
    // (the worker records the same key itself — arming both double-records).
    expect(egressRecordingEnabled('worker', true)).toBe(false);
    expect(egressRecordingEnabled('worker', false)).toBe(false);
    // egress provider: unchanged — armed iff storage is configured.
    expect(egressRecordingEnabled('egress', true)).toBe(true);
    expect(egressRecordingEnabled('egress', false)).toBe(false);
  });
});
