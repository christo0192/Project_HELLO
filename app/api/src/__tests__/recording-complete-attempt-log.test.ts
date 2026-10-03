/**
 * M009 C9-2 (PR-C) — `/recording/complete` records WHICH non-ready status the
 * attempt-first finalize returned (`attempt_finalize:<status>`), because the
 * attempt-first miss behind prod 9f43090e / 76b3793c is unproven.
 *
 * The log is diagnostic only: the route's statuses, bodies and call order are
 * unchanged, and the line carries a bounded code — never an attempt id,
 * session id, object key or digest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPhoneWorkerRouter } from '../routes/phone-worker.js';
import type { PhoneStores } from '../lib/phone-screening/index.js';

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = '99999999-8888-4777-8666-555555555555';
const SECRET = 'phone-worker-secret-0123456789abcdefghij';
const COMPLETE = '/api/internal/phone-worker/recording/complete';
const BODY = {
  attempt_id: ATTEMPT,
  session_id: SESSION,
  sha256: 'a'.repeat(64),
  size_bytes: 12345,
  duration_ms: 60000,
};

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.WORKER_CONTEXT_SECRET;
  process.env.WORKER_CONTEXT_SECRET = SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.WORKER_CONTEXT_SECRET;
  else process.env.WORKER_CONTEXT_SECRET = savedSecret;
  vi.restoreAllMocks();
});

function build(attemptStatus: 'ready' | 'pending' | 'fallback_required', sessionStatus: 'ready' | 'pending' | 'fallback_required' = 'ready') {
  const finalizeAttemptRecording = vi.fn(async () => attemptStatus);
  const finalizeRecording = vi.fn(async () => sessionStatus);
  const app = express();
  app.use(express.json());
  app.use('/api/internal/phone-worker', createPhoneWorkerRouter({
    stores: {} as unknown as PhoneStores,
    configSource: { PHONE_SCREENING_ENABLED: 'true' } as NodeJS.ProcessEnv,
    recordingProvider: 'worker',
    uploadSigner: { createUploadUrl: vi.fn() },
    finalizeRecording,
    finalizeAttemptRecording,
  }));
  return { app, finalizeAttemptRecording, finalizeRecording };
}

function post(app: express.Express) {
  return request(app).post(COMPLETE).set('Authorization', `Bearer ${SECRET}`).send(BODY);
}

function logLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

describe('C9-2 /recording/complete attempt_finalize diagnostic', () => {
  for (const status of ['pending', 'fallback_required'] as const) {
    it(`logs attempt_finalize:${status} and keeps the response unchanged`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const h = build(status);
      const res = await post(h.app);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, status });
      // Unchanged order: the session finalizer is NOT run for a non-ready attempt.
      expect(h.finalizeRecording).not.toHaveBeenCalled();
      const lines = logLines(warn).filter((l) => l.includes('recording_complete_attempt'));
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(parsed.error_category).toBe(`attempt_finalize:${status}`);
      expect(parsed.component).toBe('phone-worker');
      for (const forbidden of [ATTEMPT, SESSION, 'a'.repeat(64)]) {
        expect(lines[0]).not.toContain(forbidden);
      }
    });
  }

  it('a ready attempt logs nothing and keeps the session pass and body unchanged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const h = build('ready', 'ready');
    const res = await post(h.app);
    out.mockRestore();
    expect(res.body).toEqual({ ok: true, status: 'ready', session_status: 'ready' });
    expect(h.finalizeRecording).toHaveBeenCalledWith(SESSION);
    expect(logLines(warn).some((l) => l.includes('attempt_finalize'))).toBe(false);
    expect(logLines(out).some((l) => l.includes('attempt_finalize'))).toBe(false);
  });
});
