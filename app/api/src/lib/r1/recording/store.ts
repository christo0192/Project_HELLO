/**
 * The narrow object-store surface the R1 recording code is written against (research/api-storage.md
 * 3.4). Callers never see an AWS SDK type, so the S3 adapter (`s3-store.ts`) can be swapped for a
 * smaller signer without touching them, and every test injects the in-memory implementation
 * (`memory-store.ts`).
 *
 * Contract notes shared by every implementation:
 *  - Keys are full object keys (`r1/<round>/<session>/<name>`); callers derive them with `keys.ts`.
 *  - A URL returned by a `presign*` method is a bearer capability: it is never logged, never stored,
 *    and never put in an audit row. Presigned PUT/GET URLs carry NO flexible-checksum parameters
 *    (`x-amz-checksum-*`, `x-amz-sdk-checksum-algorithm`): a worker PUT of real bytes to such a URL
 *    would fail R2's checksum verification.
 *  - Every failure is an {@link R1StoreError}: a closed vocabulary of codes with no provider message,
 *    URL, key or id in it, so it is safe to log or to map to a job error code.
 *  - Nothing buffers an object: `read` is a stream, listings are async iterators that page lazily.
 */

export type R1StoreErrorCode =
  /** HTTP 404 / NoSuchKey on a read. */
  | 'not_found'
  /** NoSuchUpload: the multipart upload was completed, aborted or never existed. */
  | 'no_such_upload'
  /** 403 / bad credentials / signature: configuration or credential problem, not retryable. */
  | 'access_denied'
  /** 5xx, 429/SlowDown, timeout, connection reset: transient, safe to retry or defer. */
  | 'unavailable'
  /** The provider rejected the request itself (bad part list/order/size, malformed request). */
  | 'invalid_request'
  /** A delete reported a per-object error, or a delete did not take effect. */
  | 'delete_failed'
  /** A response the adapter cannot interpret (e.g. CreateMultipartUpload without an UploadId). */
  | 'bad_response';

/** A failure from the object store. `message` is the code itself, never provider text. */
export class R1StoreError extends Error {
  readonly code: R1StoreErrorCode;
  /** HTTP status when the provider gave one (diagnostic only). */
  readonly status?: number;
  constructor(code: R1StoreErrorCode, status?: number) {
    super(code);
    this.name = 'R1StoreError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
  /** Transient: the same call may succeed later. */
  get retryable(): boolean {
    return this.code === 'unavailable';
  }
}

export function isR1StoreError(value: unknown): value is R1StoreError {
  return value instanceof R1StoreError;
}

export interface R1StoredPart {
  /** 1-based part number. */
  n: number;
  size: number;
  etag: string;
}

export interface R1MultipartUploadInfo {
  key: string;
  uploadId: string;
  initiatedAt: Date;
}

export interface R1ObjectHead {
  bytes: number;
  etag: string;
  contentType?: string;
}

export interface R1ListedObject {
  key: string;
  bytes: number;
}

export interface R1PresignGetOptions {
  /** Signed `response-content-type` override (the player needs `video/mp4` regardless of how it was stored). */
  contentType?: string;
  /** Signed `response-content-disposition` override. */
  disposition?: string;
}

export interface R1ObjectStore {
  /** Start a multipart upload for `key`; returns the upload id (Secret-class). */
  createMultipart(key: string, contentType: string): Promise<string>;
  /** Presigned PUT for one part (signed headers: `host` only). */
  presignPart(key: string, uploadId: string, part: number, ttlSec: number): Promise<string>;
  /** Every uploaded part, all pages, ascending by part number. */
  listParts(key: string, uploadId: string): Promise<R1StoredPart[]>;
  /** Complete with exactly `parts` (a prefix of what was uploaded is valid). Throws `no_such_upload` if already done. */
  completeMultipart(key: string, uploadId: string, parts: ReadonlyArray<{ n: number; etag: string }>): Promise<void>;
  /** Abort. A `NoSuchUpload` is success: the goal (no upload) already holds. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
  /** Every in-progress multipart upload whose key starts with `prefix` (lazy, paged). */
  listMultipartUploads(prefix: string): AsyncIterable<R1MultipartUploadInfo>;
  /** Presigned PUT for a whole object; the `Content-Type` is SIGNED, so the PUT must send exactly it. */
  presignPut(key: string, ttlSec: number, contentType: string): Promise<string>;
  /** Presigned GET (staff playback). */
  presignGet(key: string, ttlSec: number, options?: R1PresignGetOptions): Promise<string>;
  /** Object metadata, or `null` when the object does not exist. */
  head(key: string): Promise<R1ObjectHead | null>;
  /** The object body as a stream (never buffered). Throws `not_found` when absent. */
  read(key: string): Promise<AsyncIterable<Uint8Array>>;
  /** Delete the keys. Idempotent: an absent key is success. Throws `delete_failed` if any delete fails. */
  remove(keys: string[]): Promise<void>;
  /** Every object whose key starts with `prefix` (lazy, paged). */
  listPrefix(prefix: string): AsyncIterable<R1ListedObject>;
}
