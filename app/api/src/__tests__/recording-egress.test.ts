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
    recordingFinalizeMaxAttempts: 5,
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
  probeEgressIdentity,
  egressManifestObjectKey,
  egressFinalizeConfigured,
  RECORDING_FINALIZE_DEFER_REASONS,
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
    // 0038: a poll that timed out with a correctly-filtered, non-terminal
    // answer is `poll_timeout` — DISTINCT from the storage-side and
    // identity-mismatch causes it used to be indistinguishable from.
    expect(db.rpc).toHaveBeenCalledWith('record_recording_finalize_deferral', expect.objectContaining({
      p_reason: 'poll_timeout',
      p_session_id: 'session',
    }));
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

  // ── T5 (0038, CHANGED BEHAVIOUR): zero bytes DEFERS, it does not latch ─
  // A zero-byte download is evidence about STORAGE, not about the egress. The
  // old behaviour latched `recording_egress_status = 'failed'` — a one-way
  // door — on a transient S3 5xx, an eventually-consistent read, or a finalize
  // racing the object's own write, permanently losing a recording that exists.
  // The weakening ships with its mitigation: the deferral is bounded by
  // RECORDING_FINALIZE_MAX_ATTEMPTS and terminated by
  // recording_finalize_exhausted_at (asserted in
  // recording-finalize-convergence.test.ts).
  it('T5: zero bytes defers (object_unreadable) and does NOT latch failed', async () => {
    const { db, rpc, updates } = fakeDb(
      [{ recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' }],
      Buffer.alloc(0),
    );
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client: fakeClient(),
      sleep: async () => undefined,
    });
    expect(result).toBe('pending');
    // The row was NOT written to 'failed'.
    expect(updates).not.toContainEqual({ recording_egress_status: 'failed' });
    // The cause was persisted, distinctly.
    expect(rpc).toHaveBeenCalledWith('record_recording_finalize_deferral', expect.objectContaining({
      p_reason: 'object_unreadable',
    }));
  });

  // ── T5b (0038): OVERSIZE still latches — deliberately asymmetric ─
  // An object larger than recordingMaxBytes is a DETERMINISTIC property of the
  // bytes. Retrying cannot change it, so deferring would burn the whole
  // attempt budget for nothing.
  it('T5b: an oversize object still latches failed rather than deferring', async () => {
    const { db, updates } = fakeDb(
      [{ recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' }],
      Buffer.alloc(testEnv.recordingMaxBytes + 1),
    );
    const result = await finalizeAuthoritativeRecording('session', {
      db,
      client: fakeClient(),
      sleep: async () => undefined,
    });
    expect(result).toBe('fallback_required');
    expect(updates).toContainEqual({ recording_egress_status: 'failed' });
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
    // 0038: the FINALIZE rpc must still never run on an unreadable object...
    expect(rpc).not.toHaveBeenCalledWith('finalize_authoritative_recording', expect.anything());
    // ...but the CAUSE is no longer silent. Before this, a misconfigured
    // storage gateway and an egress still flushing produced byte-identical
    // rows and byte-identical logs (none).
    expect(rpc).toHaveBeenCalledWith('record_recording_finalize_deferral', expect.objectContaining({
      p_reason: 'object_unreadable',
    }));
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


// ═══════════════════════════════════════════════════════════════════════
// 0038 — egress IDENTITY, and the three answers a listEgress response gives
// ═══════════════════════════════════════════════════════════════════════
//
// The old `terminalEgressInfo(items)` never checked WHOSE egress it found. It
// took the first terminal item in the response, so if the provider ignored the
// `egressId` filter — a shape already observed on this provider with `limit` —
// ANOTHER session's EGRESS_FAILED would latch OUR row to 'failed', permanently
// and invisibly.

describe('0038: egress identity probe', () => {
  const MINE = 'EG_synthetic123';

  it('an empty response is NOT a mismatch — it is an ordinary wait', () => {
    // Collapsing this into `identity_mismatch` would burn the attempt budget
    // of every healthy in-flight session.
    expect(probeEgressIdentity([], MINE)).toEqual({ outcome: 'not_terminal' });
    expect(probeEgressIdentity(null, MINE)).toEqual({ outcome: 'not_terminal' });
    expect(probeEgressIdentity(undefined, MINE)).toEqual({ outcome: 'not_terminal' });
  });

  it('our egress in a live state is not terminal', () => {
    const probe = probeEgressIdentity(
      [{ egressId: MINE, status: EgressStatus.EGRESS_ACTIVE }] as never,
      MINE,
    );
    expect(probe).toEqual({ outcome: 'not_terminal' });
  });

  it('our egress in a terminal state is terminal', () => {
    const probe = probeEgressIdentity(
      [{ egressId: MINE, status: EgressStatus.EGRESS_COMPLETE }] as never,
      MINE,
    );
    expect(probe.outcome).toBe('terminal');
  });

  it('a NON-EMPTY response with no item of ours is an identity mismatch', () => {
    const probe = probeEgressIdentity(
      [{ egressId: 'EG_somebodyelse999', status: EgressStatus.EGRESS_FAILED }] as never,
      MINE,
    );
    expect(probe).toEqual({ outcome: 'identity_mismatch' });
  });

  it('picks OUR item out of a response containing several', () => {
    const probe = probeEgressIdentity(
      [
        { egressId: 'EG_somebodyelse999', status: EgressStatus.EGRESS_FAILED },
        { egressId: MINE, status: EgressStatus.EGRESS_COMPLETE },
      ] as never,
      MINE,
    );
    expect(probe.outcome).toBe('terminal');
    expect(probe.outcome === 'terminal' && probe.info.egressId).toBe(MINE);
  });
});

describe('0038: identity mismatch never latches our row failed', () => {
  it("another session's EGRESS_FAILED defers as egress_identity_mismatch", async () => {
    const { db, rpc, updates } = fakeDb([
      { recording_object_key: null, recording_provenance: null, recording_egress_id: 'EG_synthetic123', recording_egress_status: 'active' },
    ]);
    // The provider ignores the filter and answers about somebody else.
    const client = {
      startRoomCompositeEgress: vi.fn(),
      stopEgress: vi.fn().mockResolvedValue({}),
      listEgress: vi.fn().mockResolvedValue([
        { egressId: 'EG_somebodyelse999', status: EgressStatus.EGRESS_FAILED },
      ]),
    } as never;

    const result = await finalizeAuthoritativeRecording('session', {
      db, client, sleep: async () => undefined,
    });

    expect(result).toBe('pending');
    // THE regression this exists for: our row is untouched.
    expect(updates).not.toContainEqual({ recording_egress_status: 'failed' });
    expect(rpc).toHaveBeenCalledWith('record_recording_finalize_deferral', expect.objectContaining({
      p_reason: 'egress_identity_mismatch',
    }));
    expect(rpc).not.toHaveBeenCalledWith('finalize_authoritative_recording', expect.anything());
  });
});

describe('0038: manifest key and configuration probe', () => {
  it('the manifest is <key>.json, not <session>-egress.json', () => {
    // Pinned against livekit-server-sdk@2.16.0: LiveKit appends `.json` to the
    // FILEPATH. Deleting a guessed `<session>-egress.json` would silently
    // succeed against an idempotent remove() and write a false compliance
    // record — the exact failure class the erasure repair ends.
    const id = '00000000-0000-4000-8000-000000000001';
    expect(egressObjectKey(id)).toBe(`${id}-egress.ogg`);
    expect(egressManifestObjectKey(id)).toBe(`${id}-egress.ogg.json`);
    expect(egressManifestObjectKey(id)).not.toBe(`${id}-egress.json`);
  });

  it('reports NOT configured when egress is disabled, so the handler defers', () => {
    // Without this pre-check, a build with egress off but legacy rows still
    // carrying an egress id would construct an EgressClient against an empty
    // URL, THROW, and dead-letter the job after five attempts — for a session
    // whose only problem is that the feature is switched off.
    testEnv.recordingEgressEnabled = false;
    expect(egressFinalizeConfigured()).toBe(false);
    testEnv.recordingEgressEnabled = true;
  });

  it('every worker-emitted defer reason is in the bounded allowlist', () => {
    // B-10: the 0038 CHECK is the AUTHORITATIVE gate and is NARROWER than the
    // queue's shape regex, so a code the worker can emit but the migration
    // does not admit would defer the JOB normally while failing the SESSION
    // write — silently, because that write is best-effort — and the health
    // surface would under-report. Keep this list and the CHECK in lockstep.
    expect([...RECORDING_FINALIZE_DEFER_REASONS].sort()).toEqual([
      'egress_disabled',
      'egress_identity_mismatch',
      'object_absent',
      'object_unreadable',
      'poll_timeout',
      'provenance_conflict',
      'provider_error',
      'rpc_unknown',
      'terminal_state',
    ]);
    for (const reason of RECORDING_FINALIZE_DEFER_REASONS) {
      // Must also satisfy the queue's own (looser) reason shape.
      expect(reason).toMatch(/^[a-z0-9_.:-]{1,64}$/);
    }
  });
});
