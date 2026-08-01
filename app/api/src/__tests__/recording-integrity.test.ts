/**
 * REC-04 (F1 repair): unit tests for the download-time SHA-256
 * re-verification primitive (lib/recording-integrity.ts).
 *
 * The injectable storage seam is faked here; the route-level behavior
 * (200 mint / 409 quarantine / 500 fail-closed / legacy skip) is covered in
 * recordings.test.ts. This suite pins every branch of verifyRecordingBytes:
 *   - legacy (no hash) → ok, storage NEVER touched
 *   - recorded size above the cap → object_too_large BEFORE any download
 *   - download throws / errors / null data → storage_download_failed (fail-closed)
 *   - fetched byte length above the cap → object_too_large
 *   - digest mismatch → digest_mismatch with actual digest
 *   - match (Buffer, Blob, ArrayBuffer payloads) → ok
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  verifyRecordingBytes,
  supabaseRecordingBytesStorage,
  RECORDING_INTEGRITY_ALGORITHM,
  RECORDING_INTEGRITY_SHA256_HEX_LENGTH,
} from '../lib/recording-integrity.js';
import type { RecordingBytesStorage } from '../lib/recording-integrity.js';

const OBJECT_KEY = 'sessions/00000000-0000-4000-8000-000000000001/recording.webm';
const MAX = 25 * 1024 * 1024;

function ctx(overrides: Partial<Parameters<typeof verifyRecordingBytes>[0]> = {}) {
  return {
    objectKey: OBJECT_KEY,
    expectedSha256: null,
    knownSizeBytes: null,
    maxBytes: MAX,
    ...overrides,
  };
}

function fakeStorage(data: unknown, mode: 'ok' | 'throw' = 'ok'): RecordingBytesStorage {
  return {
    async download() {
      if (mode === 'throw') throw new Error('storage backend boom');
      return data as { data?: Blob | ArrayBuffer | Buffer | null; error?: { message?: string } | null };
    },
  };
}

describe('verifyRecordingBytes (REC-04 F1)', () => {
  it('legacy behavior: no persisted hash → ok without touching storage', async () => {
    const download = vi.fn();
    const storage: RecordingBytesStorage = { download };
    const result = await verifyRecordingBytes(ctx(), storage);
    expect(result).toEqual({ ok: true });
    expect(download).not.toHaveBeenCalled();
  });

  it('rejects a recorded size above the cap BEFORE any download (fail-closed)', async () => {
    const download = vi.fn();
    const storage: RecordingBytesStorage = { download };
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: 'a'.repeat(64), knownSizeBytes: MAX + 1 }),
      storage,
    );
    expect(result).toEqual({ ok: false, reason: 'object_too_large', actualSizeBytes: MAX + 1 });
    expect(download).not.toHaveBeenCalled();
  });

  it('fail-closed on a thrown storage read (no URL can be minted)', async () => {
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: 'a'.repeat(64), knownSizeBytes: 16 }),
      fakeStorage(null, 'throw'),
    );
    expect(result).toEqual({ ok: false, reason: 'storage_download_failed' });
  });

  it('fail-closed on a storage error payload', async () => {
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: 'a'.repeat(64), knownSizeBytes: 16 }),
      fakeStorage({ data: null, error: { message: 'bucket unavailable' } }),
    );
    expect(result).toEqual({ ok: false, reason: 'storage_download_failed' });
  });

  it('fail-closed on null data with no error', async () => {
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: 'a'.repeat(64), knownSizeBytes: 16 }),
      fakeStorage({ data: null, error: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'storage_download_failed' });
  });

  it('rejects fetched bytes above the cap (post-download bound)', async () => {
    const big = Buffer.alloc(MAX + 1, 0x42);
    // Recorded size inside the cap (pre-download gate passes) but the bytes
    // actually fetched exceed it → post-download bound fires.
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: 'a'.repeat(64), knownSizeBytes: 16 }),
      fakeStorage({ data: big, error: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'object_too_large', actualSizeBytes: big.length });
  });

  it('detects at-rest tampering: digest mismatch returns the actual digest', async () => {
    const tampered = Buffer.from('tampered-at-rest-bytes');
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: 'f'.repeat(64), knownSizeBytes: tampered.length }),
      fakeStorage({ data: tampered, error: null }),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'digest_mismatch',
      actualSha256: createHash('sha256').update(tampered).digest('hex'),
    });
  });

  it('accepts a Buffer payload whose digest matches (ok)', async () => {
    const bytes = Buffer.from('untampered-bytes');
    const expected = createHash('sha256').update(bytes).digest('hex');
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: expected, knownSizeBytes: bytes.length }),
      fakeStorage({ data: bytes, error: null }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts a Blob payload whose digest matches (ok)', async () => {
    const bytes = Buffer.from('blob-bytes');
    const expected = createHash('sha256').update(bytes).digest('hex');
    const blob = new Blob([new Uint8Array(bytes)]);
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: expected, knownSizeBytes: bytes.length }),
      fakeStorage({ data: blob, error: null }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts an ArrayBuffer payload whose digest matches (ok)', async () => {
    const bytes = Buffer.from('arraybuffer-bytes');
    const expected = createHash('sha256').update(bytes).digest('hex');
    const ab = new Uint8Array(bytes).buffer as ArrayBuffer;
    const result = await verifyRecordingBytes(
      ctx({ expectedSha256: expected, knownSizeBytes: bytes.length }),
      fakeStorage({ data: ab, error: null }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('pins the digest algorithm + canonical length constants', () => {
    expect(RECORDING_INTEGRITY_ALGORITHM).toBe('sha256');
    expect(RECORDING_INTEGRITY_SHA256_HEX_LENGTH).toBe(64);
  });
});

describe('supabaseRecordingBytesStorage (default binding)', () => {
  it('wraps supabase.storage .download() and forwards the object key', async () => {
    const download = vi.fn().mockResolvedValue({ data: Buffer.from('x'), error: null });
    const fakeClient = {
      storage: {
        from: (bucket: string) => {
          expect(bucket).toBe('recordings_v2');
          return { download };
        },
      },
    } as never;
    const storage = supabaseRecordingBytesStorage('recordings_v2', fakeClient);
    const out = await storage.download(OBJECT_KEY);
    expect(download).toHaveBeenCalledWith(OBJECT_KEY);
    expect(out.data).toEqual(Buffer.from('x'));
  });
});
