import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Counts how often the AWS SDK module is actually evaluated. The factory runs on the first (dynamic)
// import only, so the count proves the adapter loads the SDK lazily.
const sdkLoads = vi.hoisted(() => ({ client: 0, presigner: 0 }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  sdkLoads.client += 1;
  return importOriginal();
});
vi.mock('@aws-sdk/s3-request-presigner', async (importOriginal) => {
  sdkLoads.presigner += 1;
  return importOriginal();
});

import { getR1RecordingConfig } from '../lib/r1/recording/config.js';
import { createS3Store, mapS3Error } from '../lib/r1/recording/s3-store.js';
import { R1StoreError, isR1StoreError, type R1ObjectStore } from '../lib/r1/recording/store.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';

const ACCT = '0123456789abcdef0123456789abcdef';
const KEY_ID = 'AKIAFAKEFAKEFAKEFAKE';
const SECRET = 'fake-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const ROUND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEYS = recordingKeys(ROUND, SESSION);

const config = getR1RecordingConfig({
  R1_RECORDING_S3_ENDPOINT: `https://${ACCT}.r2.cloudflarestorage.com`,
  R1_RECORDING_S3_REGION: 'auto',
  R1_RECORDING_S3_BUCKET: 'ik-r1-recordings',
  R1_RECORDING_S3_ACCESS_KEY_ID: KEY_ID,
  R1_RECORDING_S3_SECRET_ACCESS_KEY: SECRET,
});
if (!config.enabled) throw new Error('fixture config must be enabled');
const settings = config.s3;

type Sent = { name: string; input: Record<string, unknown> };
function harness(respond: (sent: Sent) => unknown | Promise<unknown>): { store: R1ObjectStore; sent: Sent[] } {
  const sent: Sent[] = [];
  const store = createS3Store(settings, {
    send: async (command) => {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      const entry = { name: c.constructor.name, input: c.input };
      sent.push(entry);
      return respond(entry);
    },
  });
  return { store, sent };
}
const providerError = (name: string, status: number, message = 'provider text with a https://secret.example/url and a key r1/x/y/z'): Error =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

// NOTE: this test must stay first: it observes the SDK before anything has used it.
describe('the SDK is loaded lazily', () => {
  it('importing the adapter and building a store loads nothing; the first operation loads the SDK once', async () => {
    expect(sdkLoads).toEqual({ client: 0, presigner: 0 });
    const { store } = harness(() => ({ UploadId: 'UP1' }));
    expect(sdkLoads).toEqual({ client: 0, presigner: 0 });
    await store.createMultipart(KEYS.stream, 'video/mp4');
    await store.createMultipart(KEYS.stream, 'video/mp4');
    expect(sdkLoads).toEqual({ client: 1, presigner: 1 });
  });

  it('only s3-store.ts references the SDK, and only with a type import or a dynamic import()', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
        } else if (/\.tsx?$/.test(name)) {
          const text = readFileSync(full, 'utf8');
          if (!text.includes('@aws-sdk/')) continue;
          const rel = path.relative(root, full).split(path.sep).join('/');
          const staticImport = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]@aws-sdk\//m.test(text);
          if (rel !== 'lib/r1/recording/s3-store.ts' || staticImport) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('S3 adapter: multipart', () => {
  it('createMultipart sends the bucket, key and content type and returns the upload id', async () => {
    const { store, sent } = harness(() => ({ UploadId: 'UP-123' }));
    await expect(store.createMultipart(KEYS.stream, 'video/mp4')).resolves.toBe('UP-123');
    expect(sent).toEqual([{ name: 'CreateMultipartUploadCommand', input: { Bucket: 'ik-r1-recordings', Key: KEYS.stream, ContentType: 'video/mp4' } }]);
  });

  it('createMultipart without an upload id is a bad response, not a silent empty id', async () => {
    const { store } = harness(() => ({}));
    await expect(store.createMultipart(KEYS.stream, 'video/mp4')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('listParts pages through every part and returns them ascending', async () => {
    const pages: Array<Record<string, unknown>> = [
      { Parts: [{ PartNumber: 3, Size: 10, ETag: '"c"' }, { PartNumber: 1, Size: 5, ETag: '"a"' }], IsTruncated: true, NextPartNumberMarker: '3' },
      { Parts: [{ PartNumber: 2, Size: 5, ETag: '"b"' }], IsTruncated: false },
    ];
    const { store, sent } = harness(() => pages.shift());
    await expect(store.listParts(KEYS.stream, 'UP1')).resolves.toEqual([
      { n: 1, size: 5, etag: '"a"' },
      { n: 2, size: 5, etag: '"b"' },
      { n: 3, size: 10, etag: '"c"' },
    ]);
    expect(sent.map((s) => s.input.PartNumberMarker)).toEqual([undefined, '3']);
    expect(sent.every((s) => s.name === 'ListPartsCommand' && s.input.UploadId === 'UP1')).toBe(true);
  });

  it('listParts treats a malformed part or a truncated page without a marker as a bad response', async () => {
    await expect(harness(() => ({ Parts: [{ PartNumber: 1 }] })).store.listParts(KEYS.stream, 'UP1')).rejects.toMatchObject({ code: 'bad_response' });
    await expect(harness(() => ({ Parts: [], IsTruncated: true })).store.listParts(KEYS.stream, 'UP1')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('completeMultipart sends exactly the listed parts, in order', async () => {
    const { store, sent } = harness(() => ({}));
    await store.completeMultipart(KEYS.stream, 'UP1', [{ n: 1, etag: '"a"' }, { n: 2, etag: '"b"' }]);
    expect(sent).toEqual([
      {
        name: 'CompleteMultipartUploadCommand',
        input: {
          Bucket: 'ik-r1-recordings',
          Key: KEYS.stream,
          UploadId: 'UP1',
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"a"' }, { PartNumber: 2, ETag: '"b"' }] },
        },
      },
    ]);
  });

  it('completeMultipart surfaces NoSuchUpload so finalize can tell "already completed"', async () => {
    const { store } = harness(() => {
      throw providerError('NoSuchUpload', 404);
    });
    await expect(store.completeMultipart(KEYS.stream, 'UP1', [{ n: 1, etag: '"a"' }])).rejects.toMatchObject({ code: 'no_such_upload' });
  });

  it('abortMultipart treats NoSuchUpload as success (the goal already holds) and nothing else', async () => {
    const gone = harness(() => {
      throw providerError('NoSuchUpload', 404);
    });
    await expect(gone.store.abortMultipart(KEYS.stream, 'UP1')).resolves.toBeUndefined();
    expect(gone.sent[0]).toMatchObject({ name: 'AbortMultipartUploadCommand', input: { Bucket: 'ik-r1-recordings', Key: KEYS.stream, UploadId: 'UP1' } });
    const down = harness(() => {
      throw providerError('ServiceUnavailable', 503);
    });
    await expect(down.store.abortMultipart(KEYS.stream, 'UP1')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('listMultipartUploads pages with key and upload-id markers under the prefix', async () => {
    const t = new Date('2026-10-12T10:00:00Z');
    const pages: Array<Record<string, unknown>> = [
      { Uploads: [{ Key: KEYS.stream, UploadId: 'U1', Initiated: t }], IsTruncated: true, NextKeyMarker: KEYS.stream, NextUploadIdMarker: 'U1' },
      { Uploads: [{ Key: KEYS.audio, UploadId: 'U2', Initiated: t }], IsTruncated: false },
    ];
    const { store, sent } = harness(() => pages.shift());
    await expect(collect(store.listMultipartUploads(KEYS.prefix))).resolves.toEqual([
      { key: KEYS.stream, uploadId: 'U1', initiatedAt: t },
      { key: KEYS.audio, uploadId: 'U2', initiatedAt: t },
    ]);
    expect(sent.map((s) => [s.input.Prefix, s.input.KeyMarker, s.input.UploadIdMarker])).toEqual([
      [KEYS.prefix, undefined, undefined],
      [KEYS.prefix, KEYS.stream, 'U1'],
    ]);
  });
});

describe('S3 adapter: objects', () => {
  it('head returns size, etag and type; a 404 is null; other failures throw a coded error', async () => {
    const ok = harness(() => ({ ContentLength: 1234, ETag: '"abc-3"', ContentType: 'video/mp4' }));
    await expect(ok.store.head(KEYS.video)).resolves.toEqual({ bytes: 1234, etag: '"abc-3"', contentType: 'video/mp4' });
    expect(ok.sent[0]).toMatchObject({ name: 'HeadObjectCommand', input: { Bucket: 'ik-r1-recordings', Key: KEYS.video } });
    const missing = harness(() => {
      throw providerError('NotFound', 404);
    });
    await expect(missing.store.head(KEYS.video)).resolves.toBeNull();
    const denied = harness(() => {
      throw providerError('Forbidden', 403);
    });
    await expect(denied.store.head(KEYS.video)).rejects.toMatchObject({ code: 'access_denied' });
    const down = harness(() => {
      throw providerError('InternalError', 500);
    });
    await expect(down.store.head(KEYS.video)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(harness(() => ({})).store.head(KEYS.video)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('read streams the body chunk by chunk and never buffers it', async () => {
    let pulled = 0;
    const body = (async function* () {
      for (let i = 0; i < 4; i += 1) {
        pulled += 1;
        yield new Uint8Array([i]);
      }
    })();
    const { store, sent } = harness(() => ({ Body: body }));
    const stream = await store.read(KEYS.video);
    expect(sent[0]).toMatchObject({ name: 'GetObjectCommand', input: { Bucket: 'ik-r1-recordings', Key: KEYS.video } });
    expect(pulled).toBe(0); // nothing was consumed to hand the stream back
    const seen: number[] = [];
    for await (const chunk of stream) {
      seen.push(chunk[0]!);
      if (chunk[0] === 1) break; // an early exit must stop the pull
    }
    expect(seen).toEqual([0, 1]);
    expect(pulled).toBe(2);
  });

  it('read maps a missing key, a missing body and a mid-stream failure', async () => {
    await expect(
      harness(() => {
        throw providerError('NoSuchKey', 404);
      }).store.read(KEYS.video),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(harness(() => ({})).store.read(KEYS.video)).rejects.toMatchObject({ code: 'bad_response' });
    const broken = (async function* () {
      yield new Uint8Array([1]);
      throw Object.assign(new Error('socket text'), { name: 'TimeoutError' });
    })();
    const stream = await harness(() => ({ Body: broken })).store.read(KEYS.video);
    await expect(collect(stream)).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
  });

  it('remove deletes key by key, tolerates an absent key and attempts every key even after a failure', async () => {
    const calls: string[] = [];
    const { store } = harness((sent) => {
      const key = sent.input.Key as string;
      calls.push(key);
      if (key === 'k-absent') throw providerError('NoSuchKey', 404);
      if (key === 'k-bad') throw providerError('InvalidRequest', 400);
      return {};
    });
    await expect(store.remove(['k-ok', 'k-absent'])).resolves.toBeUndefined();
    calls.length = 0;
    await expect(store.remove(['k-bad', 'k-ok', 'k-absent'])).rejects.toMatchObject({ code: 'delete_failed' });
    expect(calls).toEqual(['k-bad', 'k-ok', 'k-absent']);
  });

  it('remove keeps a transient or credential failure distinguishable from a refused delete', async () => {
    const transient = harness(() => {
      throw providerError('SlowDown', 503);
    });
    await expect(transient.store.remove(['k'])).rejects.toMatchObject({ code: 'unavailable' });
    const denied = harness(() => {
      throw providerError('AccessDenied', 403);
    });
    await expect(denied.store.remove(['k'])).rejects.toMatchObject({ code: 'access_denied' });
    await expect(harness(() => ({})).store.remove([])).resolves.toBeUndefined();
  });

  it('listPrefix pages with a continuation token', async () => {
    const pages: Array<Record<string, unknown>> = [
      { Contents: [{ Key: KEYS.stream, Size: 10 }], IsTruncated: true, NextContinuationToken: 'T1' },
      { Contents: [{ Key: KEYS.audio, Size: 4 }, { Key: KEYS.video }], IsTruncated: false },
    ];
    const { store, sent } = harness(() => pages.shift());
    await expect(collect(store.listPrefix(KEYS.prefix))).resolves.toEqual([
      { key: KEYS.stream, bytes: 10 },
      { key: KEYS.audio, bytes: 4 },
      { key: KEYS.video, bytes: 0 },
    ]);
    expect(sent.map((s) => [s.name, s.input.Prefix, s.input.ContinuationToken])).toEqual([
      ['ListObjectsV2Command', KEYS.prefix, undefined],
      ['ListObjectsV2Command', KEYS.prefix, 'T1'],
    ]);
  });
});

describe('S3 adapter: errors never carry provider text', () => {
  it('maps the provider vocabulary to the closed code set', () => {
    const cases: Array<[unknown, string]> = [
      [providerError('NoSuchUpload', 404), 'no_such_upload'],
      [providerError('NoSuchKey', 404), 'not_found'],
      [providerError('NotFound', 404), 'not_found'],
      [providerError('Whatever', 404), 'not_found'],
      [providerError('NoSuchBucket', 404), 'invalid_request'],
      [providerError('AccessDenied', 403), 'access_denied'],
      [providerError('SignatureDoesNotMatch', 403), 'access_denied'],
      [providerError('InvalidAccessKeyId', 403), 'access_denied'],
      [providerError('Unauthorized', 401), 'access_denied'],
      [providerError('SlowDown', 503), 'unavailable'],
      [providerError('InternalError', 500), 'unavailable'],
      [providerError('X', 502), 'unavailable'],
      [providerError('Throttling', 429), 'unavailable'],
      [providerError('RequestTimeout', 408), 'unavailable'],
      [providerError('InvalidPart', 400), 'invalid_request'],
      [providerError('EntityTooSmall', 400), 'invalid_request'],
      [Object.assign(new Error('read ECONNRESET'), { name: 'Error', code: 'ECONNRESET' }), 'unavailable'],
      [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'unavailable'],
      ['a string', 'unavailable'],
      [undefined, 'unavailable'],
    ];
    for (const [error, code] of cases) {
      const mapped = mapS3Error(error);
      expect(mapped, String((error as { name?: string })?.name)).toBeInstanceOf(R1StoreError);
      expect(mapped.code).toBe(code);
      expect(mapped.message).toBe(code);
      expect(JSON.stringify(mapped) + String(mapped.stack?.split('\n')[0])).not.toMatch(/secret\.example|r1\/x\/y\/z|provider text/);
    }
    expect(mapS3Error(providerError('SlowDown', 503)).retryable).toBe(true);
    expect(mapS3Error(providerError('AccessDenied', 403)).retryable).toBe(false);
    const existing = new R1StoreError('not_found');
    expect(mapS3Error(existing)).toBe(existing);
    expect(isR1StoreError(existing)).toBe(true);
    expect(isR1StoreError(new Error('x'))).toBe(false);
  });

  it('a failure while loading the SDK is reported as unavailable, not thrown raw', async () => {
    vi.resetModules();
    vi.doMock('@aws-sdk/client-s3', () => {
      throw new Error('cannot load');
    });
    const fresh = await import('../lib/r1/recording/s3-store.js');
    const store = fresh.createS3Store(settings);
    await expect(store.head(KEYS.video)).rejects.toMatchObject({ code: 'unavailable' });
    vi.doUnmock('@aws-sdk/client-s3');
    vi.resetModules();
  });
});

/** Presign through the PRODUCTION factory (real SDK, real signing, fake credentials). */
function parse(raw: string): { url: URL; query: Map<string, string> } {
  const url = new URL(raw);
  return { url, query: new Map([...url.searchParams.entries()]) };
}
const CHECKSUM_KEY = /^x-amz-(?:checksum|sdk-checksum-algorithm)/i;

describe('presigned URLs carry no flexible-checksum parameters and the right signed headers', () => {
  const store = createS3Store(settings);

  it('UploadPart: path-style host and bucket, partNumber/uploadId, host-only signature, 600 s', async () => {
    const { url, query } = parse(await store.presignPart(KEYS.stream, 'UP1', 3, 600));
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(`${ACCT}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/ik-r1-recordings/${KEYS.stream}`);
    expect(query.get('partNumber')).toBe('3');
    expect(query.get('uploadId')).toBe('UP1');
    expect(query.get('X-Amz-SignedHeaders')).toBe('host');
    expect(query.get('X-Amz-Expires')).toBe('600');
    expect(query.get('x-id')).toBe('UploadPart');
    expect([...query.keys()].filter((k) => CHECKSUM_KEY.test(k))).toEqual([]);
    expect(query.get('X-Amz-Credential')).toMatch(new RegExp(`^${KEY_ID}/\\d{8}/auto/s3/aws4_request$`));
  });

  it('PutObject: signs content-type (and host), no checksum parameters, 600 s', async () => {
    const { url, query } = parse(await store.presignPut(KEYS.audioPartial, 600, 'audio/ogg'));
    expect(url.host).toBe(`${ACCT}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/ik-r1-recordings/${KEYS.audioPartial}`);
    expect(query.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(query.get('X-Amz-Expires')).toBe('600');
    expect(query.get('x-id')).toBe('PutObject');
    expect([...query.keys()].filter((k) => CHECKSUM_KEY.test(k))).toEqual([]);
  });

  it('PutObject signs the content type the caller chose (a different type is a different signature)', async () => {
    const a = parse(await store.presignPut(KEYS.video, 600, 'video/mp4')).query.get('X-Amz-Signature');
    const b = parse(await store.presignPut(KEYS.video, 600, 'audio/mp4')).query.get('X-Amz-Signature');
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('GetObject: response-content-type (and disposition) are signed query overrides, no checksum mode, 300 s', async () => {
    const { query } = parse(await store.presignGet(KEYS.video, 300, { contentType: 'video/mp4', disposition: 'inline' }));
    expect(query.get('response-content-type')).toBe('video/mp4');
    expect(query.get('response-content-disposition')).toBe('inline');
    expect(query.get('X-Amz-SignedHeaders')).toBe('host');
    expect(query.get('X-Amz-Expires')).toBe('300');
    expect(query.get('x-id')).toBe('GetObject');
    expect([...query.keys()].filter((k) => CHECKSUM_KEY.test(k))).toEqual([]);
    const bare = parse(await store.presignGet(KEYS.video, 300)).query;
    expect(bare.has('response-content-type')).toBe(false);
  });

  it('never puts the secret key in a URL', async () => {
    const urls = [
      await store.presignPart(KEYS.stream, 'UP1', 1, 600),
      await store.presignPut(KEYS.audio, 600, 'audio/ogg'),
      await store.presignGet(KEYS.video, 300),
    ];
    for (const u of urls) {
      expect(u).not.toContain(SECRET);
      expect(u).not.toContain(encodeURIComponent(SECRET));
    }
  });

  it('rejects a lifetime outside 1..3600 s and a non-integer one', async () => {
    for (const ttl of [0, -1, 3601, 1.5, Number.NaN]) {
      await expect(store.presignGet(KEYS.video, ttl)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(store.presignPart(KEYS.stream, 'UP1', 1, ttl)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(store.presignPut(KEYS.audio, ttl, 'audio/ogg')).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(store.presignGet(KEYS.video, 1)).resolves.toContain('X-Amz-Expires=1');
  });

  it('signs different keys, upload ids and part numbers differently (no shared signature)', async () => {
    const sig = async (key: string, up: string, part: number): Promise<string | undefined> =>
      parse(await store.presignPart(key, up, part, 600)).query.get('X-Amz-Signature');
    const base = await sig(KEYS.stream, 'UP1', 1);
    expect(await sig(KEYS.stream, 'UP1', 2)).not.toBe(base);
    expect(await sig(KEYS.stream, 'UP2', 1)).not.toBe(base);
    expect(await sig(KEYS.video, 'UP1', 1)).not.toBe(base);
  });
});
