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
 * (`listEngagementRecordings` → `attachAttemptRecording`), the synthetic
 * `EG_worker_` egress id is recorded and stamped, and an upload URL comes back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  prepareWorkerRecording,
  workerRecordingEgressId,
  type PrepareWorkerRecordingDeps,
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
    createUploadUrl,
  };
}

const INPUT = {
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
    expect(order).toEqual(['list', 'attach', 'finalize', 'stamp', 'sign']);
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

  it('a duplicate attach re-mints the URL without re-attaching', async () => {
    const h = harness({ attach: { status: 'ok', duplicate: true } });
    const result = await prepareWorkerRecording(INPUT, h.deps);
    expect(result.status).toBe('already_prepared');
    expect(result.boundForUpload).toBe(true);
    expect(result.uploadUrl).toBe('https://storage.invalid/put/phone-object?token=abc');
    // A duplicate does NOT re-record the egress id or re-stamp the session.
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.stamp).not.toHaveBeenCalled();
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
