/**
 * REC-04 (Phase 7 flash repair, F1): download-time SHA-256 re-verification
 * for secondary browser recordings.
 *
 * The upload path persists `recording_sha256` (computed over the bytes at
 * upload) but the upload-time mismatch check was unreachable in practice
 * (the per-session quota gate rejects a second upload before any comparison
 * could run), so at-rest tampering was never actually detected. This module
 * is the REAL verify-on-download seam:
 *
 *   - When `recording_sha256` is present, the stored object bytes are
 *     fetched through an INJECTABLE/MOCKABLE storage seam, hashed
 *     server-side, and compared against the persisted digest.
 *   - Resource use is bounded consistently with the upload cap
 *     (RECORDING_MAX_BYTES / the recorded `recording_size_bytes`): an object
 *     whose recorded size already exceeds the cap is rejected BEFORE any
 *     download, and the downloaded bytes are re-checked against the cap.
 *     (Full constant-memory streaming re-verify stays external-pending —
 *     consistent with C-3; the pre-download known-size gate bounds the fetch.)
 *   - Fail-closed: a storage download/hash failure returns
 *     `storage_download_failed` and the caller must NEVER mint a URL.
 *   - `expectedSha256` null (no hash persisted — legacy rows) is the
 *     truthful legacy behavior: nothing is downloaded, verification is
 *     skipped, and the caller mints as before.
 *
 * No URL, object key, or token is ever emitted from this module; callers
 * audit only session_id + sha256 PREFIX + reason (invariant 7).
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from './supabase.js';

/** SHA-256 digest algorithm pinned for recording integrity (REC-01 half). */
export const RECORDING_INTEGRITY_ALGORITHM = 'sha256' as const;
/** Canonical SHA-256 hex digest length (64 chars) — validates persisted values. */
export const RECORDING_INTEGRITY_SHA256_HEX_LENGTH = 64;

/**
 * Injectable storage seam: fetches the stored object bytes.
 * Tests substitute an in-memory synthetic; the default binding wraps
 * Supabase Storage `.download()`.
 */
export interface RecordingBytesStorage {
  /**
   * Resolve with `{ data }` on success or `{ error }` on failure — never
   * throws. Fail-closed callers treat ANY error as "cannot verify".
   */
  download(
    objectKey: string,
  ): Promise<{ data?: Blob | ArrayBuffer | Buffer | null; error?: { message?: string } | null }>;
}

/**
 * Default binding: Supabase Storage `.from(bucket).download(objectKey)`.
 * `clientOverride` is the repo's standard DI seam for test isolation.
 */
export function supabaseRecordingBytesStorage(
  bucket: string,
  clientOverride?: SupabaseClient,
): RecordingBytesStorage {
  const client = (clientOverride ?? defaultSupabase) as unknown as SupabaseClient;
  return {
    async download(objectKey: string) {
      const { data, error } = await client.storage.from(bucket).download(objectKey);
      return { data: data ?? undefined, error };
    },
  };
}

export type RecordingVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'storage_download_failed' }
  | { ok: false; reason: 'object_too_large'; actualSizeBytes: number }
  | { ok: false; reason: 'digest_mismatch'; actualSha256: string };

export interface RecordingVerifyContext {
  objectKey: string;
  /** Persisted SHA-256 hex digest; null ⇒ legacy behavior (no re-verify). */
  expectedSha256: string | null;
  /** Recorded byte size from call_sessions (null for legacy rows). */
  knownSizeBytes: number | null;
  /** Resource bound — the upload cap (RECORDING_MAX_BYTES). */
  maxBytes: number;
}

async function toBuffer(data: Blob | ArrayBuffer | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    // Blob (DOM/Browser + Node 18+ global): arrayBuffer() is async.
    return Buffer.from(await data.arrayBuffer());
  }
  return Buffer.from(new Uint8Array(data as unknown as ArrayBuffer));
}

/**
 * Re-verify the stored bytes against the persisted digest (REC-04, F1).
 * Pure function over the injectable storage — no I/O beyond `storage`.
 */
export async function verifyRecordingBytes(
  ctx: RecordingVerifyContext,
  storage: RecordingBytesStorage,
): Promise<RecordingVerifyResult> {
  // Truthful legacy behavior: no persisted digest ⇒ no re-verification, no
  // download, mint proceeds exactly as before 0014.
  if (!ctx.expectedSha256) {
    return { ok: true };
  }

  // Bound resource use BEFORE any fetch: a recorded size above the upload
  // cap is anomalous (the upload path never writes one) — fail closed.
  if (ctx.knownSizeBytes !== null && ctx.knownSizeBytes > ctx.maxBytes) {
    return { ok: false, reason: 'object_too_large', actualSizeBytes: ctx.knownSizeBytes };
  }

  let result: { data?: Blob | ArrayBuffer | Buffer | null; error?: { message?: string } | null };
  try {
    result = await storage.download(ctx.objectKey);
  } catch {
    return { ok: false, reason: 'storage_download_failed' };
  }
  if (result.error || result.data == null) {
    return { ok: false, reason: 'storage_download_failed' };
  }

  let buffer: Buffer;
  try {
    buffer = await toBuffer(result.data);
  } catch {
    // Unhashable bytes — treat as unverifiable, never mint.
    return { ok: false, reason: 'storage_download_failed' };
  }

  // Re-check the fetched byte length against the cap (fail-closed).
  if (buffer.byteLength > ctx.maxBytes) {
    return { ok: false, reason: 'object_too_large', actualSizeBytes: buffer.byteLength };
  }

  const actualSha256 = createHash('sha256').update(buffer).digest('hex');
  if (actualSha256 !== ctx.expectedSha256) {
    return { ok: false, reason: 'digest_mismatch', actualSha256 };
  }
  return { ok: true };
}
