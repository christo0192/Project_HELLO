/**
 * The Cloudflare R2 adapter behind {@link R1ObjectStore}, built on AWS SDK v3.
 *
 * The SDK is loaded LAZILY (`await import(...)` on first use): importing this module costs nothing,
 * and the API's boot path (which also runs phone dialing) never loads ~16 MB of SDK, nor can a broken
 * SDK install stop it from booting. Only `import type` appears at the top level.
 *
 * Three SDK defaults are wrong for R2 and are pinned here (and by `r1-recording-store.test.ts`):
 *  1. Flexible checksums. With the default `requestChecksumCalculation: 'WHEN_SUPPORTED'` a presigned
 *     UploadPart/PutObject URL carries `x-amz-checksum-crc32=AAAAAA==` (the CRC of an EMPTY body) and
 *     `x-amz-sdk-checksum-algorithm=CRC32`, so a worker PUT of real bytes would fail verification, and
 *     a presigned GetObject carries `x-amz-checksum-mode`. `'WHEN_REQUIRED'` on both knobs removes them.
 *  2. Addressing. `forcePathStyle: true` makes every URL `https://<acct>.r2.cloudflarestorage.com/
 *     <bucket>/<key>`: one hostname for the web CSP `media-src` and the bucket CORS rule.
 *  3. Content-Type. The presigner leaves `content-type` UNSIGNED by default; `presignPut` signs it
 *     (`signableHeaders`) so a PUT can only store the type the API chose.
 *
 * Errors never carry provider text: every failure is an {@link R1StoreError} with a closed code.
 */

import type { R1RecordingS3Settings } from './config.js';
import {
  R1StoreError,
  type R1ListedObject,
  type R1MultipartUploadInfo,
  type R1ObjectHead,
  type R1ObjectStore,
  type R1PresignGetOptions,
  type R1StoredPart,
} from './store.js';

type S3Module = typeof import('@aws-sdk/client-s3');
type PresignerModule = typeof import('@aws-sdk/s3-request-presigner');

export interface S3StoreDeps {
  /**
   * Test seam: replaces the network send for every NON-presign operation. Presigning is a local
   * computation and always runs through the real SDK so the URLs under test are the production ones.
   */
  send?: (command: unknown) => Promise<unknown>;
}

const MAX_PAGES = 200; // a runaway-pagination guard; real listings are a handful of pages
const MIN_PRESIGN_TTL_SEC = 1;
const MAX_PRESIGN_TTL_SEC = 3600; // far above anything this feature issues (<= 900), far below R2's 7 days

const AUTH_NAMES = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'InvalidToken',
  'Forbidden',
  'CredentialsProviderError',
]);
const TRANSIENT_NAMES = new Set([
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
  'NetworkingError',
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
]);

/** Map any thrown value to the closed {@link R1StoreError} vocabulary (no provider text survives). */
export function mapS3Error(error: unknown): R1StoreError {
  if (error instanceof R1StoreError) return error;
  const e = (error ?? {}) as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof e.name === 'string' ? e.name : typeof e.Code === 'string' ? e.Code : '';
  const status = typeof e.$metadata?.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : undefined;
  if (name === 'NoSuchUpload') return new R1StoreError('no_such_upload', status);
  if (name === 'NoSuchKey' || name === 'NotFound' || (status === 404 && name !== 'NoSuchBucket')) {
    return new R1StoreError('not_found', status);
  }
  if (name === 'NoSuchBucket') return new R1StoreError('invalid_request', status);
  if (AUTH_NAMES.has(name) || status === 401 || status === 403) return new R1StoreError('access_denied', status);
  if (TRANSIENT_NAMES.has(name) || status === 429 || status === 408 || (status !== undefined && status >= 500)) {
    return new R1StoreError('unavailable', status);
  }
  if (status !== undefined) return new R1StoreError('invalid_request', status);
  // No HTTP status: a socket-level failure (reset, DNS, timeout) the SDK could not complete.
  return new R1StoreError('unavailable');
}

function checkTtl(ttlSec: number): number {
  if (!Number.isInteger(ttlSec) || ttlSec < MIN_PRESIGN_TTL_SEC || ttlSec > MAX_PRESIGN_TTL_SEC) {
    throw new R1StoreError('invalid_request');
  }
  return ttlSec;
}

async function* iterateBody(body: AsyncIterable<unknown>): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of body) yield chunk as Uint8Array;
  } catch (error) {
    throw mapS3Error(error);
  }
}

/**
 * Build the R2 store. `settings` is the validated `enabled` config's `s3` block; nothing here reads
 * the environment, so tests and the smoke script can point it anywhere (e.g. a local S3).
 */
export function createS3Store(settings: R1RecordingS3Settings, deps: S3StoreDeps = {}): R1ObjectStore {
  const { bucket } = settings;

  interface Kit {
    s3: S3Module;
    presigner: PresignerModule;
    client: InstanceType<S3Module['S3Client']>;
  }
  let kitPromise: Promise<Kit> | undefined;
  function kit(): Promise<Kit> {
    kitPromise ??= (async (): Promise<Kit> => {
      try {
        const [s3, presigner] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);
        const client = new s3.S3Client({
          region: settings.region,
          endpoint: settings.endpoint,
          forcePathStyle: true,
          // R2 does not implement the SDK's default flexible checksums: see the module header.
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
          credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
          maxAttempts: 3,
          requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
        });
        return { s3, presigner, client };
      } catch (error) {
        kitPromise = undefined; // allow a later retry; a failed import must not be cached forever
        throw mapS3Error(error);
      }
    })();
    return kitPromise;
  }

  async function send<T>(build: (s3: S3Module) => unknown): Promise<T> {
    const { s3, client } = await kit();
    const command = build(s3);
    try {
      const result = deps.send
        ? await deps.send(command)
        : await (client as unknown as { send(c: unknown): Promise<unknown> }).send(command);
      return result as T;
    } catch (error) {
      throw mapS3Error(error);
    }
  }

  async function presign(build: (s3: S3Module) => unknown, ttlSec: number, extra: { signableHeaders?: Set<string> } = {}): Promise<string> {
    const expiresIn = checkTtl(ttlSec);
    const { s3, presigner, client } = await kit();
    try {
      return await presigner.getSignedUrl(client, build(s3) as Parameters<PresignerModule['getSignedUrl']>[1], { expiresIn, ...extra });
    } catch (error) {
      throw mapS3Error(error);
    }
  }

  return {
    async createMultipart(key, contentType) {
      const out = await send<{ UploadId?: string }>((s3) => new s3.CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
      if (!out?.UploadId) throw new R1StoreError('bad_response');
      return out.UploadId;
    },

    presignPart(key, uploadId, part, ttlSec) {
      return presign((s3) => new s3.UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: part }), ttlSec);
    },

    async listParts(key, uploadId) {
      const parts: R1StoredPart[] = [];
      let marker: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const out = await send<{
          Parts?: Array<{ PartNumber?: number; Size?: number; ETag?: string }>;
          IsTruncated?: boolean;
          NextPartNumberMarker?: string;
        }>((s3) => new s3.ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, ...(marker ? { PartNumberMarker: marker } : {}) }));
        for (const p of out?.Parts ?? []) {
          if (typeof p.PartNumber !== 'number' || typeof p.Size !== 'number' || typeof p.ETag !== 'string') throw new R1StoreError('bad_response');
          parts.push({ n: p.PartNumber, size: p.Size, etag: p.ETag });
        }
        if (!out?.IsTruncated) return parts.sort((a, b) => a.n - b.n);
        if (!out.NextPartNumberMarker) throw new R1StoreError('bad_response');
        marker = out.NextPartNumberMarker;
      }
      throw new R1StoreError('bad_response');
    },

    async completeMultipart(key, uploadId, parts) {
      await send((s3) =>
        new s3.CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.n, ETag: p.etag })) },
        }),
      );
    },

    async abortMultipart(key, uploadId) {
      try {
        await send((s3) => new s3.AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
      } catch (error) {
        // NoSuchUpload: already completed, aborted or never created. The goal (no upload) holds.
        if (error instanceof R1StoreError && error.code === 'no_such_upload') return;
        throw error;
      }
    },

    async *listMultipartUploads(prefix): AsyncGenerator<R1MultipartUploadInfo> {
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const out = await send<{
          Uploads?: Array<{ Key?: string; UploadId?: string; Initiated?: Date }>;
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextUploadIdMarker?: string;
        }>(
          (s3) =>
            new s3.ListMultipartUploadsCommand({
              Bucket: bucket,
              Prefix: prefix,
              ...(keyMarker ? { KeyMarker: keyMarker } : {}),
              ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
            }),
        );
        for (const u of out?.Uploads ?? []) {
          if (typeof u.Key !== 'string' || typeof u.UploadId !== 'string') throw new R1StoreError('bad_response');
          yield { key: u.Key, uploadId: u.UploadId, initiatedAt: u.Initiated instanceof Date ? u.Initiated : new Date(0) };
        }
        if (!out?.IsTruncated) return;
        if (!out.NextKeyMarker && !out.NextUploadIdMarker) throw new R1StoreError('bad_response');
        keyMarker = out.NextKeyMarker;
        uploadIdMarker = out.NextUploadIdMarker;
      }
      throw new R1StoreError('bad_response');
    },

    presignPut(key, ttlSec, contentType) {
      // content-type is signed, so the worker's PUT must send exactly this value (C4).
      return presign((s3) => new s3.PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), ttlSec, {
        signableHeaders: new Set(['content-type']),
      });
    },

    presignGet(key, ttlSec, options: R1PresignGetOptions = {}) {
      return presign(
        (s3) =>
          new s3.GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
            ...(options.disposition ? { ResponseContentDisposition: options.disposition } : {}),
          }),
        ttlSec,
      );
    },

    async head(key): Promise<R1ObjectHead | null> {
      try {
        const out = await send<{ ContentLength?: number; ETag?: string; ContentType?: string }>((s3) => new s3.HeadObjectCommand({ Bucket: bucket, Key: key }));
        if (typeof out?.ContentLength !== 'number' || typeof out.ETag !== 'string') throw new R1StoreError('bad_response');
        return { bytes: out.ContentLength, etag: out.ETag, ...(out.ContentType ? { contentType: out.ContentType } : {}) };
      } catch (error) {
        if (error instanceof R1StoreError && error.code === 'not_found') return null;
        throw error;
      }
    },

    async read(key) {
      const out = await send<{ Body?: AsyncIterable<unknown> }>((s3) => new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!out?.Body || typeof (out.Body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') throw new R1StoreError('bad_response');
      return iterateBody(out.Body);
    },

    async remove(keys) {
      // One DeleteObject per key (a recording has a handful): no multi-delete XML, no Content-MD5
      // requirement to satisfy on R2. Every key is attempted even after a failure so an erase makes
      // as much progress as it can; the first failure is rethrown at the end.
      let failure: R1StoreError | undefined;
      for (const key of keys) {
        try {
          await send((s3) => new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
        } catch (error) {
          const mapped = error instanceof R1StoreError ? error : mapS3Error(error);
          if (mapped.code === 'not_found') continue; // already absent: idempotent
          failure ??= mapped.code === 'unavailable' || mapped.code === 'access_denied' ? mapped : new R1StoreError('delete_failed', mapped.status);
        }
      }
      if (failure) throw failure;
    },

    async *listPrefix(prefix): AsyncGenerator<R1ListedObject> {
      let token: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const out = await send<{
          Contents?: Array<{ Key?: string; Size?: number }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        }>((s3) => new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
        for (const o of out?.Contents ?? []) {
          if (typeof o.Key !== 'string') throw new R1StoreError('bad_response');
          yield { key: o.Key, bytes: typeof o.Size === 'number' ? o.Size : 0 };
        }
        if (!out?.IsTruncated) return;
        if (!out.NextContinuationToken) throw new R1StoreError('bad_response');
        token = out.NextContinuationToken;
      }
      throw new R1StoreError('bad_response');
    },
  };
}
