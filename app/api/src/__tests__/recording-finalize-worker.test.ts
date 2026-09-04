/**
 * PR A — the WORKER-INBAND branch of `finalizeAuthoritativeRecording`, and the
 * property that distinguishes it from the egress branch:
 *
 *   IT NEVER STOPS OR POLLS AN EGRESS.
 *
 * The worker already uploaded the MP3, so finalize is pure download + hash +
 * size-check + manifest + link. A session carrying the synthetic `EG_worker_`
 * egress id is dispatched here; every test asserts the injected egress client's
 * `stopEgress`/`listEgress` were NEVER called, and that the linked columns
 * carry `worker_inband` provenance and the re-hashed integrity values.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { testEnv } = vi.hoisted(() => ({
  testEnv: {
    livekitUrl: 'wss://synthetic.livekit.invalid',
    livekitApiKey: 'synthetic-key',
    livekitApiSecret: 'synthetic-secret',
    recordingsBucket: 'recordings_v2',
    recordingEgressEnabled: true,
    recordingEgressRequired: false,
    recordingEgressS3Endpoint: 'https://synthetic.storage.invalid/s3',
    recordingEgressS3Region: 'ap-south-1',
    recordingEgressS3AccessKeyId: 'synthetic-access',
    recordingEgressS3SecretAccessKey: 'synthetic-secret',
    recordingEgressFinalizeTimeoutMs: 2_000,
    recordingMaxBytes: 25 * 1024 * 1024,
    recordingFinalizeMaxAttempts: 5,
  },
}));

vi.mock('../lib/env.js', () => ({ env: testEnv }));
vi.mock('../lib/supabase.js', () => ({ supabase: {} }));

import {
  finalizeAuthoritativeRecording,
  finalizeWorkerInbandRecording,
  isWorkerInbandEgressId,
  markWorkerRecordingFailed,
  sniffRecordingContentType,
} from '../lib/recording-egress.js';

const SESSION = '99999999-8888-4777-8666-555555555555';
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const WORKER_EGRESS_ID = `EG_worker_${ATTEMPT}`;
const OBJECT_KEY = `phone-${ATTEMPT}-egress.mp3`;
const MANIFEST_KEY = `${OBJECT_KEY}.json`;

/**
 * A db + storage fake. `callSessionRows` feeds the two `call_sessions.single()`
 * reads (dispatch read, then the worker-branch re-read). `phoneAttemptRow` is
 * the attempt binding. `bytes` is what storage.download returns; a manifest
 * upload can be forced to conflict.
 */
function fakeDb(opts: {
  callSessionRows: unknown[];
  phoneAttemptRow?: unknown;
  bytes?: Buffer;
  downloadError?: boolean;
  manifestUploadError?: boolean;
  existingManifestBytes?: Buffer | null;
}) {
  const updates: Record<string, unknown>[] = [];
  const rpc = vi.fn().mockResolvedValue({ data: { status: 'ok' }, error: null });
  const uploadCalls: unknown[] = [];

  const from = vi.fn((table: string) => {
    let operation = 'select';
    const chain: any = {
      select: vi.fn(() => chain),
      update: vi.fn((payload: Record<string, unknown>) => {
        operation = 'update';
        updates.push(payload);
        return chain;
      }),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      not: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      single: vi.fn(async () => ({ data: opts.callSessionRows.shift() ?? null, error: null })),
      maybeSingle: vi.fn(async () => ({
        data: table === 'phone_call_attempts' ? (opts.phoneAttemptRow ?? null) : null,
        error: null,
      })),
      then: (resolve: (value: unknown) => void) => resolve(
        operation === 'update'
          ? { data: [{ id: SESSION }], error: null }
          : { data: [], error: null },
      ),
    };
    return chain;
  });

  const storage = {
    from: vi.fn(() => ({
      upload: vi.fn(async (key: string, body: Buffer) => {
        uploadCalls.push({ key, body });
        return opts.manifestUploadError
          ? { data: null, error: { message: 'exists' } }
          : { data: { path: key }, error: null };
      }),
      download: vi.fn(async (key: string) => {
        if (key === MANIFEST_KEY) {
          return opts.existingManifestBytes
            ? { data: new Blob([new Uint8Array(opts.existingManifestBytes)]), error: null }
            : { data: null, error: { message: 'not found' } };
        }
        if (opts.downloadError) return { data: null, error: { message: 'unreadable' } };
        return {
          data: new Blob([new Uint8Array(opts.bytes ?? Buffer.from('synthetic mp3'))], { type: 'audio/mpeg' }),
          error: null,
        };
      }),
    })),
  };

  return { db: { from, rpc, storage } as any, updates, uploadCalls };
}

/** An egress client whose methods must NEVER be called on the worker branch. */
function egressSpy() {
  return {
    startRoomCompositeEgress: vi.fn(),
    stopEgress: vi.fn(),
    listEgress: vi.fn(),
  } as any;
}

describe('finalizeWorkerInbandRecording — no egress stop/poll', () => {
  beforeEach(() => {
    Object.assign(testEnv, { recordingMaxBytes: 25 * 1024 * 1024 });
  });

  it('recognizes the synthetic worker egress id', () => {
    expect(isWorkerInbandEgressId(WORKER_EGRESS_ID)).toBe(true);
    expect(isWorkerInbandEgressId('EG_realegress123')).toBe(false);
  });

  it('downloads + hashes + links with worker_inband provenance and NEVER touches egress', async () => {
    const bytes = Buffer.from('a synthetic worker-recorded mp3 payload');
    const { db, updates, uploadCalls } = fakeDb({
      callSessionRows: [
        // dispatch read (finalizeAuthoritativeRecording)
        {
          recording_object_key: null,
          recording_provenance: 'worker_inband',
          recording_egress_id: WORKER_EGRESS_ID,
          recording_egress_status: 'complete',
          mode: 'live',
        },
        // worker-branch re-read
        {
          recording_egress_id: WORKER_EGRESS_ID,
          recording_object_key: null,
          recording_provenance: 'worker_inband',
        },
      ],
      phoneAttemptRow: { recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY },
      bytes,
    });
    const client = egressSpy();

    const status = await finalizeAuthoritativeRecording(SESSION, { db, client });
    expect(status).toBe('ready');

    // NEVER stopped or polled an egress.
    expect(client.stopEgress).not.toHaveBeenCalled();
    expect(client.listEgress).not.toHaveBeenCalled();

    // The manifest was written to the derived key.
    expect(uploadCalls).toHaveLength(1);
    expect((uploadCalls[0] as { key: string }).key).toBe(MANIFEST_KEY);

    // The link carried the RE-HASHED sha and worker_inband provenance.
    const link = updates.find((u) => 'recording_object_key' in u);
    expect(link).toBeDefined();
    expect(link!.recording_object_key).toBe(OBJECT_KEY);
    expect(link!.recording_provenance).toBe('worker_inband');
    expect(link!.recording_content_type).toBe('audio/mpeg');
    expect(link!.recording_size_bytes).toBe(bytes.length);
    expect(link!.recording_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(link!.recording_egress_status).toBe('complete');
  });

  // ── v114 (2026-09-04): the raw-OGG FALLBACK content type ──────────────
  // When the worker's OGG→MP3 transcode dies on a channel desync it uploads the
  // RAW OGG to the SAME `.mp3` key rather than lose the audio. The finalizer
  // sniffs the object's container bytes, so it records `audio/ogg` — the
  // QA-visible signal that the MP3 transcode failed but the audio was retained —
  // instead of mislabeling OGG bytes as MP3.
  it('records audio/ogg content type when the object is a raw-OGG fallback', async () => {
    // A minimal object whose leading bytes are the Ogg capture pattern "OggS".
    const bytes = Buffer.concat([Buffer.from('OggS'), Buffer.from('\x00 raw ogg fallback payload')]);
    const { db, updates } = fakeDb({
      callSessionRows: [
        {
          recording_object_key: null,
          recording_provenance: 'worker_inband',
          recording_egress_id: WORKER_EGRESS_ID,
          recording_egress_status: 'complete',
          mode: 'live',
        },
        { recording_egress_id: WORKER_EGRESS_ID, recording_object_key: null, recording_provenance: 'worker_inband' },
      ],
      phoneAttemptRow: { recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY },
      bytes,
    });
    const client = egressSpy();

    const status = await finalizeAuthoritativeRecording(SESSION, { db, client });
    expect(status).toBe('ready');
    const link = updates.find((u) => 'recording_object_key' in u);
    expect(link).toBeDefined();
    // The honest fallback marker: a worker_inband recording carrying audio/ogg.
    expect(link!.recording_content_type).toBe('audio/ogg');
    expect(link!.recording_provenance).toBe('worker_inband');
    // Audio was retained, not lost: the row still links + completes.
    expect(link!.recording_egress_status).toBe('complete');
    expect(link!.recording_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('sniffRecordingContentType distinguishes OGG from MP3 by magic bytes', () => {
    expect(sniffRecordingContentType(Buffer.from('OggS\x00stuff'))).toBe('audio/ogg');
    // ID3-tagged MP3, raw MPEG frame sync, and anything non-Ogg → audio/mpeg.
    expect(sniffRecordingContentType(Buffer.from('ID3\x04mp3'))).toBe('audio/mpeg');
    expect(sniffRecordingContentType(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('audio/mpeg');
    expect(sniffRecordingContentType(Buffer.from('random'))).toBe('audio/mpeg');
    // Too short to carry the pattern → default to mpeg (never throws).
    expect(sniffRecordingContentType(Buffer.from('Og'))).toBe('audio/mpeg');
  });

  it('enforces the size cap: an oversize object LATCHES to failed (fallback_required)', async () => {
    testEnv.recordingMaxBytes = 8; // tiny cap
    const bytes = Buffer.from('this payload is definitely larger than eight bytes');
    const { db, updates, uploadCalls } = fakeDb({
      callSessionRows: [
        {
          recording_object_key: null,
          recording_provenance: 'worker_inband',
          recording_egress_id: WORKER_EGRESS_ID,
          recording_egress_status: 'complete',
          mode: 'live',
        },
        { recording_egress_id: WORKER_EGRESS_ID, recording_object_key: null, recording_provenance: 'worker_inband' },
      ],
      phoneAttemptRow: { recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY },
      bytes,
    });
    const client = egressSpy();

    const status = await finalizeAuthoritativeRecording(SESSION, { db, client });
    expect(status).toBe('fallback_required');
    // Latched to failed, no manifest written, no key linked, no egress touched.
    expect(uploadCalls).toHaveLength(0);
    expect(client.stopEgress).not.toHaveBeenCalled();
    const failed = updates.find((u) => u.recording_egress_status === 'failed');
    expect(failed).toBeDefined();
    expect(updates.some((u) => 'recording_object_key' in u)).toBe(false);
  });

  it('defers (pending) on a transient unreadable download', async () => {
    const { db } = fakeDb({
      callSessionRows: [
        {
          recording_object_key: null,
          recording_provenance: 'worker_inband',
          recording_egress_id: WORKER_EGRESS_ID,
          recording_egress_status: 'complete',
          mode: 'live',
        },
        { recording_egress_id: WORKER_EGRESS_ID, recording_object_key: null, recording_provenance: 'worker_inband' },
      ],
      phoneAttemptRow: { recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY },
      downloadError: true,
    });
    const client = egressSpy();
    const status = await finalizeAuthoritativeRecording(SESSION, { db, client });
    expect(status).toBe('pending');
    expect(client.listEgress).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-linked worker recording is READY without re-download', async () => {
    const { db, uploadCalls } = fakeDb({
      callSessionRows: [
        {
          recording_object_key: OBJECT_KEY, // already linked
          recording_provenance: 'worker_inband',
          recording_egress_id: WORKER_EGRESS_ID,
          recording_egress_status: 'complete',
          mode: 'live',
        },
      ],
    });
    const client = egressSpy();
    const status = await finalizeAuthoritativeRecording(SESSION, { db, client });
    expect(status).toBe('ready');
    expect(uploadCalls).toHaveLength(0);
    expect(client.stopEgress).not.toHaveBeenCalled();
  });

  it('an idempotent manifest re-upload verifies existing bytes and still links', async () => {
    const bytes = Buffer.from('idempotent worker mp3');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const canonicalManifest = Buffer.from(JSON.stringify({
      schema_version: 1,
      object_key: OBJECT_KEY,
      content_type: 'audio/mpeg',
      sha256,
      size_bytes: bytes.length,
      provider_duration_ms: null,
      egress_id: WORKER_EGRESS_ID,
      finalized_at: null,
    }));
    const { db, updates } = fakeDb({
      callSessionRows: [
        { recording_egress_id: WORKER_EGRESS_ID, recording_object_key: null, recording_provenance: 'worker_inband' },
      ],
      phoneAttemptRow: { recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY },
      bytes,
      manifestUploadError: true,
      existingManifestBytes: canonicalManifest,
    });
    // Call the worker branch directly (dispatch already decided).
    const status = await finalizeWorkerInbandRecording(SESSION, { db });
    expect(status).toBe('ready');
    expect(updates.some((u) => u.recording_provenance === 'worker_inband')).toBe(true);
  });
});

describe('worker-inband failure latching (live 2026-09-03, EG_worker_a6cc612d)', () => {
  // The worker's finish() failed silently, its local audio was already deleted,
  // and the finalizer retried the never-uploaded key to exhaustion while the
  // session sat at `recording_egress_status='active'` ("Recording is still
  // processing") forever. These pin the three repairs: the worker-report latch,
  // the finalizer fast-fail on a latched session, and the exhaustion latch.

  it('markWorkerRecordingFailed latches an unlinked worker session to failed', async () => {
    const { db, updates } = fakeDb({
      callSessionRows: [
        { recording_egress_id: WORKER_EGRESS_ID, recording_object_key: null },
      ],
    });
    const status = await markWorkerRecordingFailed(SESSION, ATTEMPT, { db });
    expect(status).toBe('failed_latched');
    const latch = updates.find((u) => u.recording_egress_status === 'failed');
    expect(latch).toBeDefined();
    // The persisted defer reason stays inside the 0038 CHECK vocabulary.
    expect(latch!.recording_finalize_defer_reason).toBe('provider_error');
  });

  it('markWorkerRecordingFailed never clobbers a linked recording', async () => {
    const { db, updates } = fakeDb({
      callSessionRows: [
        { recording_egress_id: WORKER_EGRESS_ID, recording_object_key: OBJECT_KEY },
      ],
    });
    expect(await markWorkerRecordingFailed(SESSION, ATTEMPT, { db })).toBe('already_linked');
    expect(updates).toHaveLength(0);
  });

  it('markWorkerRecordingFailed refuses a real (non-worker) egress id', async () => {
    const { db, updates } = fakeDb({
      callSessionRows: [
        { recording_egress_id: 'EG_realegress123', recording_object_key: null },
      ],
    });
    expect(await markWorkerRecordingFailed(SESSION, ATTEMPT, { db })).toBe('not_worker_inband');
    expect(updates).toHaveLength(0);
  });

  it('the finalizer fast-fails a latched session — no download, no retry cycle', async () => {
    const { db, updates } = fakeDb({
      callSessionRows: [
        {
          recording_egress_id: WORKER_EGRESS_ID,
          recording_object_key: null,
          recording_provenance: 'worker_inband',
          recording_egress_status: 'failed',
        },
      ],
      downloadError: true,
    });
    const status = await finalizeWorkerInbandRecording(SESSION, { db });
    expect(status).toBe('fallback_required');
    // No deferral write, no further status update — the latch already answered.
    expect(updates).toHaveLength(0);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('an EXHAUSTED deferral latches the status to failed instead of active-forever', async () => {
    const { db, updates } = fakeDb({
      callSessionRows: [
        {
          recording_egress_id: WORKER_EGRESS_ID,
          recording_object_key: null,
          recording_provenance: 'worker_inband',
          recording_egress_status: 'active',
        },
      ],
      phoneAttemptRow: { recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY },
      downloadError: true,
    });
    db.rpc.mockResolvedValue({ data: { attempts: 6, exhausted: true }, error: null });
    const status = await finalizeWorkerInbandRecording(SESSION, { db });
    expect(status).toBe('pending');
    const latch = updates.find((u) => u.recording_egress_status === 'failed');
    expect(latch).toBeDefined();
  });

  it('a non-exhausted deferral does NOT latch — the retry budget still owns it', async () => {
    const { db, updates } = fakeDb({
      callSessionRows: [
        {
          recording_egress_id: WORKER_EGRESS_ID,
          recording_object_key: null,
          recording_provenance: 'worker_inband',
          recording_egress_status: 'active',
        },
      ],
      phoneAttemptRow: { recording_object_key: OBJECT_KEY, recording_manifest_key: MANIFEST_KEY },
      downloadError: true,
    });
    db.rpc.mockResolvedValue({ data: { attempts: 2, exhausted: false }, error: null });
    const status = await finalizeWorkerInbandRecording(SESSION, { db });
    expect(status).toBe('pending');
    expect(updates.find((u) => u.recording_egress_status === 'failed')).toBeUndefined();
  });
});

describe('markWorkerRecordingFailed — attempt binding + truthful latch outcome (review repairs)', () => {
  it("a STALE attempt's late report cannot latch a session a newer attempt re-prepared", async () => {
    const NEWER_ATTEMPT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const { db, updates } = fakeDb({
      callSessionRows: [
        // The session's CURRENT binding belongs to the newer attempt.
        { recording_egress_id: `EG_worker_${NEWER_ATTEMPT}`, recording_object_key: null },
      ],
    });
    expect(await markWorkerRecordingFailed(SESSION, ATTEMPT, { db })).toBe('attempt_mismatch');
    expect(updates).toHaveLength(0);
  });
});
