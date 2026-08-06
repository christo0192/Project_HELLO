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
  safeEgressStartedAtMs,
  validateEpochMsAnchor,
  MAX_EPOCH_MS_ANCHOR,
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

function fakeClient(status = EgressStatus.EGRESS_COMPLETE, startedAt = 1700000000000000000n) {
  return {
    startRoomCompositeEgress: vi.fn().mockResolvedValue({ egressId: 'EG_synthetic123' }),
    stopEgress: vi.fn().mockResolvedValue({ egressId: 'EG_synthetic123' }),
    listEgress: vi.fn().mockResolvedValue([{ egressId: 'EG_synthetic123', status, startedAt }]),
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
      p_recording_egress_started_at_ms: 1700000000000,
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
      p_recording_egress_started_at_ms: 1700000000000,
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

// ═══════════════════════════════════════════════════════════════════
// 0026: pure timing-anchor helpers — deterministic, zero I/O
// ═══════════════════════════════════════════════════════════════════

describe('safeEgressStartedAtMs', () => {
  it('converts valid nanos to ms', () => {
    // 1700000000123456789n ns → 1700000000123 ms (integer division truncates)
    expect(safeEgressStartedAtMs(1700000000123456789n)).toBe(1700000000123);
  });

  it('returns epoch-ms for a current-era timestamp', () => {
    // ~2026-01-01 in nanos
    const ms = safeEgressStartedAtMs(1_767_000_000_000_000_000n);
    expect(ms).toBe(1_767_000_000_000);
  });

  it('returns null for null', () => {
    expect(safeEgressStartedAtMs(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(safeEgressStartedAtMs(undefined)).toBeNull();
  });

  it('returns null for 0n (EGRESS_STARTING, not authoritative)', () => {
    expect(safeEgressStartedAtMs(0n)).toBeNull();
  });

  it('returns null for negative nanos', () => {
    expect(safeEgressStartedAtMs(-1n)).toBeNull();
  });

  it('returns null when ms result exceeds MAX_EPOCH_MS_ANCHOR (year 2100)', () => {
    // nanos = MAX_EPOCH_MS_ANCHOR * 1e6 + 1 → ms would be beyond the bound
    const farFutureNanos = BigInt(MAX_EPOCH_MS_ANCHOR) * 1_000_000n + 1n;
    expect(safeEgressStartedAtMs(farFutureNanos)).toBeNull();
  });

  it('accepts exactly MAX_EPOCH_MS_ANCHOR - 1 in ms', () => {
    const nanos = BigInt(MAX_EPOCH_MS_ANCHOR - 1) * 1_000_000n;
    expect(safeEgressStartedAtMs(nanos)).toBe(MAX_EPOCH_MS_ANCHOR - 1);
  });
});

describe('validateEpochMsAnchor', () => {
  // ── Happy path: valid number ────────────────────────────────────
  it('accepts a positive integer number within range', () => {
    expect(validateEpochMsAnchor(1700000000123)).toBe(1700000000123);
  });

  it('accepts a numeric string that unambiguously represents the value', () => {
    expect(validateEpochMsAnchor('1700000000123')).toBe(1700000000123);
  });

  it('accepts bigint within range as a number', () => {
    expect(validateEpochMsAnchor(BigInt(1700000000123))).toBe(1700000000123);
  });

  // ── null / undefined ───────────────────────────────────────────
  it('returns null for null', () => {
    expect(validateEpochMsAnchor(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(validateEpochMsAnchor(undefined)).toBeNull();
  });

  // ── Invalid types ──────────────────────────────────────────────
  it('returns null for true (boolean)', () => {
    expect(validateEpochMsAnchor(true)).toBeNull();
  });

  it('returns null for false (boolean)', () => {
    expect(validateEpochMsAnchor(false)).toBeNull();
  });

  it('returns null for an object', () => {
    expect(validateEpochMsAnchor({})).toBeNull();
  });

  it('returns null for an array', () => {
    expect(validateEpochMsAnchor([1, 2, 3])).toBeNull();
  });

  it('returns null for a function', () => {
    expect(validateEpochMsAnchor(() => 1)).toBeNull();
  });

  it('returns null for a symbol', () => {
    expect(validateEpochMsAnchor(Symbol('test'))).toBeNull();
  });

  // ── Invalid number values ──────────────────────────────────────
  it('returns null for NaN', () => {
    expect(validateEpochMsAnchor(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(validateEpochMsAnchor(Infinity)).toBeNull();
  });

  it('returns null for -Infinity', () => {
    expect(validateEpochMsAnchor(-Infinity)).toBeNull();
  });

  it('returns null for 0', () => {
    expect(validateEpochMsAnchor(0)).toBeNull();
  });

  it('returns null for a negative number', () => {
    expect(validateEpochMsAnchor(-1)).toBeNull();
  });

  it('returns null for a float', () => {
    expect(validateEpochMsAnchor(1700000000123.5)).toBeNull();
  });

  it('returns null for a value equal to MAX_EPOCH_MS_ANCHOR', () => {
    expect(validateEpochMsAnchor(MAX_EPOCH_MS_ANCHOR)).toBeNull();
  });

  it('returns null for a value exceeding MAX_EPOCH_MS_ANCHOR', () => {
    expect(validateEpochMsAnchor(MAX_EPOCH_MS_ANCHOR + 1)).toBeNull();
  });

  // ── Invalid string values ──────────────────────────────────────
  it('returns null for an empty string', () => {
    expect(validateEpochMsAnchor('')).toBeNull();
  });

  it('returns null for a string with leading zeros', () => {
    expect(validateEpochMsAnchor('01700000000123')).toBeNull();
  });

  it('returns null for a string with decimal point', () => {
    expect(validateEpochMsAnchor('1700000000123.0')).toBeNull();
  });

  it('returns null for a string with whitespace', () => {
    expect(validateEpochMsAnchor(' 1700000000123 ')).toBeNull();
  });

  it('returns null for a hex string', () => {
    expect(validateEpochMsAnchor('0x18b')).toBeNull();
  });

  it('returns null for a negative numeric string', () => {
    expect(validateEpochMsAnchor('-1')).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(validateEpochMsAnchor('abcd')).toBeNull();
  });

  it('returns null for a string that rounds differently (loss of precision)', () => {
    // "9007199254740993" > Number.MAX_SAFE_INTEGER — Number() rounds it
    expect(validateEpochMsAnchor('9007199254740993')).toBeNull();
  });
});
