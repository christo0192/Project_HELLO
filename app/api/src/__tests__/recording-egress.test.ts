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

  it('hashes and atomically finalizes a completed egress object', async () => {
    const { db, rpc } = fakeDb([
      { recording_object_key: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    const result = await finalizeAuthoritativeRecording(
      '00000000-0000-4000-8000-000000000001',
      { db, client: fakeClient(), sleep: async () => undefined },
    );
    expect(result).toBe('ready');
    expect(rpc).toHaveBeenCalledWith('finalize_recording_upload', expect.objectContaining({
      p_object_key: egressObjectKey('00000000-0000-4000-8000-000000000001'),
      p_content_type: 'audio/ogg',
      p_provenance: 'livekit_egress',
      p_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('finalization is idempotent when a recording is already linked', async () => {
    const { db, rpc } = fakeDb([
      { recording_object_key: 'already.ogg', recording_egress_id: 'EG_synthetic123', recording_egress_status: 'complete' },
    ]);
    const client = fakeClient();
    const result = await finalizeAuthoritativeRecording('session', { db, client });
    expect(result).toBe('ready');
    expect(client.stopEgress).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requests browser fallback only after terminal egress failure', async () => {
    const { db } = fakeDb([
      { recording_object_key: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client: fakeClient(EgressStatus.EGRESS_FAILED),
      sleep: async () => undefined,
    });
    expect(result).toBe('fallback_required');
  });
});
