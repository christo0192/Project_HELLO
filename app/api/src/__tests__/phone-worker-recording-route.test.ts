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
import { createPhoneWorkerRouter, egressRecordingEnabled } from '../routes/phone-worker.js';
import type { PhoneStores } from '../lib/phone-screening/index.js';
import type { WorkerRecordingUploadSigner } from '../integrations/livekit-phone-dial/worker-recording.js';

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '99999999-8888-4777-8666-555555555555';
const SECRET = 'phone-worker-secret-0123456789abcdefghij';

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
  finalizeThrows?: boolean;
  markFailedStatus?: 'failed_latched' | 'already_linked' | 'not_worker_inband' | 'session_not_found';
  markFailedThrows?: boolean;
  /** When set, wires a resolveEngagement dep so an omitted engagement_id can be
   *  resolved server-side (PR A in-worker recorder path). */
  resolveEngagement?: ((attemptId: string) => Promise<{
    engagementId: string;
    engagementState: string;
    version: number;
    sessionId?: string;
  } | null>) | undefined;
}

function build(opts: BuildOpts = {}) {
  const list = vi.fn(async () => ({ status: 'ok', artifacts: [] }));
  const attach = vi.fn(async () => ({
    status: opts.attachStatus ?? 'ok',
    duplicate: opts.attachDuplicate ?? false,
  }));
  const finalizeAttemptRecording = vi.fn(async (_input: { egressId?: string | null }) => ({ status: 'ok' }));
  const stampSessionEgress = vi.fn(async (_input: { egressId: string }) => ({ status: 'ok', duplicate: false }));

  const stores = {
    listEngagementRecordings: list,
    attachAttemptRecording: attach,
    finalizeAttemptRecording,
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
      markRecordingFailed,
      resolveEngagement: opts.resolveEngagement,
    }),
  );

  return { app, list, attach, finalizeAttemptRecording, stampSessionEgress, createUploadUrl, finalizeRecording, markRecordingFailed };
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
    // Synthetic egress id recorded + stamped.
    expect(h.finalizeAttemptRecording.mock.calls[0][0].egressId).toBe(`EG_worker_${ATTEMPT}`);
    expect(h.stampSessionEgress.mock.calls[0][0].egressId).toBe(`EG_worker_${ATTEMPT}`);
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
    expect(res.body).toEqual({ ok: true, status: 'ready' });
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

  it('a finalizer throw is a sanitized 500', async () => {
    const h = build({ recordingProvider: 'worker', finalizeThrows: true });
    const res = await authed(h.app, COMPLETE, COMPLETE_BODY);
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('phone_recording_complete_error');
  });

  it('rejects a malformed sha256 with 400', async () => {
    const h = build({ recordingProvider: 'worker' });
    const res = await authed(h.app, COMPLETE, { ...COMPLETE_BODY, sha256: 'tooshort' });
    expect(res.status).toBe(400);
    expect(h.finalizeRecording).not.toHaveBeenCalled();
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
    expect(h.markRecordingFailed).toHaveBeenCalledWith(SESSION);
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
