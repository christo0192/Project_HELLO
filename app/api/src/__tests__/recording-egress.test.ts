import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EgressStatus } from 'livekit-server-sdk';

const { testEnv } = vi.hoisted(() => ({
  testEnv: {
    livekitUrl: 'wss://synthetic.livekit.invalid',
    livekitApiKey: 'synthetic-key',
    livekitApiSecret: 'synthetic-secret',
    recordingsBucket: 'recordings_v2',
    recordingEgressEnabled: true,
    recordingEgressRequired: true,
    recordingEgressS3Endpoint: 'https://synthetic.storage.invalid/s3',
    recordingEgressS3Region: 'ap-south-1',
    recordingEgressS3AccessKeyId: 'synthetic-access',
    recordingEgressS3SecretAccessKey: 'synthetic-secret',
    recordingEgressFinalizeTimeoutMs: 2_000,
    recordingMaxBytes: 25 * 1024 * 1024,
  },
}));

vi.mock('../lib/env.js', () => ({ env: testEnv }));
vi.mock('../lib/supabase.js', () => ({ supabase: {} }));

import {
  authoritativeRecordingEnabled,
  egressObjectKey,
  finalizeAuthoritativeRecording,
  startAuthoritativeRecording,
} from '../lib/recording-egress.js';

function fakeDb(singleRows: unknown[], bytes = Buffer.from('synthetic audio')) {
  const updates: unknown[] = [];
  const rpc = vi.fn().mockResolvedValue({ data: { status: 'ok' }, error: null });
  const from = vi.fn(() => {
    let operation = 'select';
    const chain: any = {
      select: vi.fn(() => chain),
      update: vi.fn((payload) => {
        operation = 'update';
        updates.push(payload);
        return chain;
      }),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      single: vi.fn(async () => ({ data: singleRows.shift() ?? null, error: null })),
      then: (resolve: (value: unknown) => void) => resolve(
        operation === 'update' ? { data: [{ id: 'session' }], error: null } : { data: [], error: null },
      ),
    };
    return chain;
  });
  return {
    db: {
      from,
      rpc,
      storage: {
        from: vi.fn(() => ({
          download: vi.fn(async () => ({
            data: new Blob([bytes], { type: 'audio/ogg' }),
            error: null,
          })),
        })),
      },
    } as any,
    updates,
    rpc,
  };
}

function fakeClient(status = EgressStatus.EGRESS_COMPLETE) {
  return {
    startRoomCompositeEgress: vi.fn().mockResolvedValue({ egressId: 'EG_synthetic123' }),
    stopEgress: vi.fn().mockResolvedValue({ egressId: 'EG_synthetic123' }),
    listEgress: vi.fn().mockResolvedValue([{ egressId: 'EG_synthetic123', status }]),
  } as any;
}

describe('authoritative recording egress', () => {
  beforeEach(() => {
    Object.assign(testEnv, {
      recordingEgressEnabled: true,
      recordingEgressRequired: true,
      recordingEgressS3AccessKeyId: 'synthetic-access',
      recordingEgressS3SecretAccessKey: 'synthetic-secret',
    });
  });

  it('fails closed when required egress storage is not configured', () => {
    testEnv.recordingEgressS3AccessKeyId = '';
    expect(() => authoritativeRecordingEnabled()).toThrow(/storage is not configured/);
  });

  it('starts audio egress once and links its opaque identifier', async () => {
    const { db, updates } = fakeDb([{ recording_egress_id: null }]);
    const client = fakeClient();
    const result = await startAuthoritativeRecording(
      'screening-00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      { db, client },
    );
    expect(result).toEqual({ status: 'started', egressId: 'EG_synthetic123' });
    expect(client.startRoomCompositeEgress).toHaveBeenCalledOnce();
    expect(updates).toContainEqual({
      recording_egress_id: 'EG_synthetic123',
      recording_egress_status: 'active',
    });
  });

  it('does not start a duplicate egress when one is already linked', async () => {
    const { db } = fakeDb([{ recording_egress_id: 'EG_existing123' }]);
    const client = fakeClient();
    const result = await startAuthoritativeRecording('room', 'session', { db, client });
    expect(result.egressId).toBe('EG_existing123');
    expect(client.startRoomCompositeEgress).not.toHaveBeenCalled();
  });

  it('hashes and atomically finalizes a completed egress object via authoritative RPC', async () => {
    const { db, rpc } = fakeDb([
      { recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    const result = await finalizeAuthoritativeRecording(
      '00000000-0000-4000-8000-000000000001',
      { db, client: fakeClient(), sleep: async () => undefined },
    );
    expect(result).toBe('ready');
    expect(rpc).toHaveBeenCalledWith('finalize_authoritative_recording', expect.objectContaining({
      p_session_id: '00000000-0000-4000-8000-000000000001',
      p_object_key: egressObjectKey('00000000-0000-4000-8000-000000000001'),
      p_content_type: 'audio/ogg',
      p_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('finalization is idempotent when provenance is already livekit_egress', async () => {
    const { db, rpc } = fakeDb([
      { recording_object_key: 'already.ogg', recording_provenance: 'livekit_egress', recording_egress_id: 'EG_synthetic123', recording_egress_status: 'complete' },
    ]);
    const client = fakeClient();
    const result = await finalizeAuthoritativeRecording('session', { db, client });
    expect(result).toBe('ready');
    expect(client.stopEgress).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requests browser fallback only after terminal egress failure', async () => {
    const { db } = fakeDb([
      { recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client: fakeClient(EgressStatus.EGRESS_FAILED),
      sleep: async () => undefined,
    });
    expect(result).toBe('fallback_required');
  });

  // ── T1: browser_upload key + egress id → does NOT return ready early; repoints ─
  it('T1: does NOT return ready when provenance is browser_upload with egress set', async () => {
    const { db, rpc } = fakeDb([
      { recording_object_key: 'browser.webm', recording_provenance: 'browser_upload', recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    const client = fakeClient();
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client,
      sleep: async () => undefined,
    });
    // Must fall through to stop/wait/download/hash → repoint RPC
    expect(result).toBe('ready');
    expect(rpc).toHaveBeenCalledWith('finalize_authoritative_recording', expect.objectContaining({
      p_session_id: 'session',
    }));
    // Must NOT short-circuit early — stopEgress must have been called
    expect(client.stopEgress).toHaveBeenCalled();
  });

  // ── T2: provenance already livekit_egress → ready, zero RPC calls ─
  it('T2: provenance already livekit_egress returns ready with zero RPC calls', async () => {
    const { db, rpc } = fakeDb([
      { recording_object_key: 'egress.ogg', recording_provenance: 'livekit_egress', recording_egress_id: 'EG_synthetic123', recording_egress_status: 'complete' },
    ]);
    const result = await finalizeAuthoritativeRecording('session', { db, client: fakeClient() });
    expect(result).toBe('ready');
    expect(rpc).not.toHaveBeenCalled();
  });

  // ── T3: egress non-terminal until timeout → pending (never fallback_required) ─
  it('T3: returns pending when egress does not reach terminal state within timeout', async () => {
    const { db } = fakeDb([
      { recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    // listEgress returns active (non-terminal), never terminal
    const client = fakeClient(EgressStatus.EGRESS_ACTIVE);
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client,
      sleep: async () => undefined,
    });
    expect(result).toBe('pending');
  });

  // ── T4: EGRESS_FAILED / _ABORTED / _LIMIT_REACHED → fallback_required ─
  it('T4: returns fallback_required for EGRESS_ABORTED', async () => {
    const { db } = fakeDb([
      { recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client: fakeClient(EgressStatus.EGRESS_ABORTED),
      sleep: async () => undefined,
    });
    expect(result).toBe('fallback_required');
  });

  it('T4b: returns fallback_required for EGRESS_LIMIT_REACHED', async () => {
    const { db } = fakeDb([
      { recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client: fakeClient(EgressStatus.EGRESS_LIMIT_REACHED),
      sleep: async () => undefined,
    });
    expect(result).toBe('fallback_required');
  });

  // ── T5: zero-byte egress object → fallback_required ─
  it('T5: returns fallback_required when the egress object has zero bytes', async () => {
    const { db } = fakeDb(
      [{ recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' }],
      Buffer.alloc(0),
    );
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client: fakeClient(),
      sleep: async () => undefined,
    });
    expect(result).toBe('fallback_required');
  });

  // ── T6: storage download error → pending, no RPC ─
  it('T6: returns pending when storage download fails, no RPC called', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: 'ok' }, error: null });
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: { recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
              error: null,
            })),
          })),
        })),
      })),
      rpc,
      storage: {
        from: vi.fn(() => ({
          download: vi.fn(async () => ({ data: null, error: { message: 'bucket error' } })),
        })),
      },
    } as any;
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client: fakeClient(),
      sleep: async () => undefined,
    });
    expect(result).toBe('pending');
    expect(rpc).not.toHaveBeenCalled();
  });

  // ── no egress id → fallback_required ─
  it('returns fallback_required when session has no recording_egress_id', async () => {
    const { db } = fakeDb([
      { recording_object_key: null, recording_provenance: null, recording_egress_id: null, recording_egress_status: null },
    ]);
    const result = await finalizeAuthoritativeRecording('session', { db, client: fakeClient() });
    expect(result).toBe('fallback_required');
  });
});
