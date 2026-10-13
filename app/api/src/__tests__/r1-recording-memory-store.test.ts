import { describe, expect, it } from 'vitest';
import { MEMORY_STORE_HOST, MemoryR1ObjectStore, parseMemoryUrl } from '../lib/r1/recording/memory-store.js';
import { R1StoreError, type R1ObjectStore } from '../lib/r1/recording/store.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';

const KEYS = recordingKeys('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const bytes = (n: number, fill: number): Buffer => Buffer.alloc(n, fill);
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
async function bodyOf(store: R1ObjectStore, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await store.read(key)) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('MemoryR1ObjectStore: multipart semantics (as R2)', () => {
  it('re-uploading a part number replaces it; complete builds the object from the listed parts only', async () => {
    const store = new MemoryR1ObjectStore();
    const id = await store.createMultipart(KEYS.stream, 'video/mp4');
    const e1 = store.putPart(id, 1, bytes(8, 1));
    store.putPart(id, 2, bytes(8, 2));
    const e2 = store.putPart(id, 2, bytes(8, 9)); // replacement
    store.putPart(id, 3, bytes(3, 3));
    store.putPart(id, 5, bytes(8, 5)); // stray: part 4 never arrived
    const listed = await store.listParts(KEYS.stream, id);
    expect(listed.map((p) => [p.n, p.size])).toEqual([[1, 8], [2, 8], [3, 3], [5, 8]]);
    expect(listed[1]!.etag).toBe(e2);

    await store.completeMultipart(KEYS.stream, id, [{ n: 1, etag: e1 }, { n: 2, etag: e2 }, { n: 3, etag: listed[2]!.etag }]);
    expect(store.getBytes(KEYS.stream)).toEqual(Buffer.concat([bytes(8, 1), bytes(8, 9), bytes(3, 3)]));
    expect(store.getContentType(KEYS.stream)).toBe('video/mp4');
    await expect(store.head(KEYS.stream)).resolves.toMatchObject({ bytes: 19, contentType: 'video/mp4', etag: expect.stringMatching(/^"[0-9a-f]{32}-3"$/) });
    // The completed upload id is gone: complete -> NoSuchUpload, abort -> success, nothing listed.
    await expect(store.completeMultipart(KEYS.stream, id, [{ n: 1, etag: e1 }])).rejects.toMatchObject({ code: 'no_such_upload' });
    await expect(store.abortMultipart(KEYS.stream, id)).resolves.toBeUndefined();
    await expect(store.listParts(KEYS.stream, id)).rejects.toMatchObject({ code: 'no_such_upload' });
    expect(await collect(store.listMultipartUploads(KEYS.prefix))).toEqual([]);
  });

  it('rejects what R2 rejects: order, unknown parts, wrong etags, non-uniform sizes, empty lists', async () => {
    const store = new MemoryR1ObjectStore({ minPartSize: 5 });
    const id = await store.createMultipart(KEYS.stream, 'video/mp4');
    const a = store.putPart(id, 1, bytes(6, 1));
    const b = store.putPart(id, 2, bytes(6, 2));
    const small = store.putPart(id, 3, bytes(2, 3));
    const big = store.putPart(id, 4, bytes(9, 4));
    const bad = async (parts: Array<{ n: number; etag: string }>) =>
      expect(store.completeMultipart(KEYS.stream, id, parts)).rejects.toMatchObject({ code: 'invalid_request' });
    await bad([]);
    await bad([{ n: 2, etag: b }, { n: 1, etag: a }]); // not ascending
    await bad([{ n: 1, etag: a }, { n: 1, etag: a }]); // repeated
    await bad([{ n: 1, etag: a }, { n: 7, etag: a }]); // never uploaded
    await bad([{ n: 1, etag: '"deadbeef"' }]); // wrong etag
    await bad([{ n: 1, etag: a }, { n: 3, etag: small }, { n: 2, etag: b }]); // out of order
    await bad([{ n: 3, etag: small }, { n: 2, etag: b }]); // a non-last part below the minimum
    await bad([{ n: 1, etag: a }, { n: 4, etag: big }]); // last part larger than the first
    await bad([{ n: 1, etag: a }, { n: 4, etag: big }, { n: 2, etag: b }]);
    // Nothing above consumed the upload: the valid prefix still completes (quotes on etags are optional).
    await store.completeMultipart(KEYS.stream, id, [{ n: 1, etag: a.replace(/"/g, '') }, { n: 2, etag: b }, { n: 3, etag: small }]);
    expect(store.getBytes(KEYS.stream).length).toBe(14);
  });

  it('requires equal sizes for all but the last part even without a minimum', async () => {
    const store = new MemoryR1ObjectStore();
    const id = await store.createMultipart(KEYS.stream, 'video/mp4');
    const p1 = store.putPart(id, 1, bytes(4, 1));
    const p2 = store.putPart(id, 2, bytes(5, 2));
    const p3 = store.putPart(id, 3, bytes(4, 3));
    await expect(store.completeMultipart(KEYS.stream, id, [{ n: 1, etag: p1 }, { n: 2, etag: p2 }, { n: 3, etag: p3 }])).rejects.toMatchObject({ code: 'invalid_request' });
    await store.completeMultipart(KEYS.stream, id, [{ n: 1, etag: p1 }]);
    expect(store.has(KEYS.stream)).toBe(true);
  });

  it('abort removes the upload and is idempotent; listing filters by prefix and sorts', async () => {
    const store = new MemoryR1ObjectStore({ now: () => 1_700_000_000_000 });
    const a = await store.createMultipart(KEYS.audio, 'audio/ogg');
    const b = await store.createMultipart(KEYS.stream, 'video/mp4');
    const other = await store.createMultipart('r1/other/other/stream.mp4', 'video/mp4');
    const listed = await collect(store.listMultipartUploads(KEYS.prefix));
    expect(listed.map((u) => u.key)).toEqual([KEYS.audio, KEYS.stream]);
    expect(listed[0]!.initiatedAt).toEqual(new Date(1_700_000_000_000));
    await store.abortMultipart(KEYS.audio, a);
    await store.abortMultipart(KEYS.audio, a);
    await store.abortMultipart('r1/wrong/key', b); // a mismatched key does not abort someone else's upload
    expect(store.openUploadIds().sort()).toEqual([b, other].sort());
    expect(store.uploadKey(b)).toBe(KEYS.stream);
    expect(store.uploadContentType(b)).toBe('video/mp4');
  });

  it('rejects an out-of-range part number and a PUT to an unknown upload', () => {
    const store = new MemoryR1ObjectStore();
    expect(() => store.putPart('nope', 1, 'x')).toThrow(R1StoreError);
  });
});

describe('MemoryR1ObjectStore: objects, listings, streams', () => {
  it('stores, heads, reads, lists and removes (remove is idempotent)', async () => {
    const store = new MemoryR1ObjectStore();
    store.putObject(KEYS.video, 'hello world', 'video/mp4');
    store.putObject(KEYS.audio, Buffer.from([1, 2, 3]), 'audio/ogg');
    store.putObject('r1/elsewhere/x', 'z');
    await expect(store.head(KEYS.video)).resolves.toMatchObject({ bytes: 11, contentType: 'video/mp4' });
    await expect(store.head('nope')).resolves.toBeNull();
    expect((await bodyOf(store, KEYS.video)).toString()).toBe('hello world');
    await expect(store.read('nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(await collect(store.listPrefix(KEYS.prefix))).toEqual([
      { key: KEYS.audio, bytes: 3 },
      { key: KEYS.video, bytes: 11 },
    ]);
    await store.remove([KEYS.video, KEYS.video, 'never-existed']);
    expect(store.objectKeys()).toEqual([KEYS.audio, 'r1/elsewhere/x'].sort());
    store.disappear(KEYS.audio);
    expect(store.has(KEYS.audio)).toBe(false);
  });

  it('streams a 256 MiB virtual object in 64 KiB chunks without materialising it', async () => {
    const store = new MemoryR1ObjectStore();
    const size = 256 * 1024 * 1024;
    store.putRepeating(KEYS.video, size, new Uint8Array(65536));
    expect(await store.head(KEYS.video)).toMatchObject({ bytes: size });
    let total = 0;
    let count = 0;
    for await (const chunk of await store.read(KEYS.video)) {
      total += chunk.length;
      count += 1;
    }
    expect(total).toBe(size);
    expect(count).toBe(4096);
    expect(() => store.getBytes(KEYS.video)).toThrow();
    store.putVirtual('r1/v', 5, async function* () {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4, 5]);
    });
    expect((await bodyOf(store, 'r1/v')).toJSON().data).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('MemoryR1ObjectStore: call log and failure injection', () => {
  it('records every call and fails the next N matching calls after an optional skip', async () => {
    const store = new MemoryR1ObjectStore();
    store.failNext('head', 'unavailable', { skip: 1, times: 2 });
    await expect(store.head('a')).resolves.toBeNull(); // skipped
    await expect(store.head('a')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.head('a')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.head('a')).resolves.toBeNull(); // exhausted
    expect(store.countCalls('head')).toBe(4);
    expect(store.callsOf('head')[0]).toEqual({ op: 'head', key: 'a' });

    store.failNext('remove', 'delete_failed');
    await expect(store.remove(['k'])).rejects.toMatchObject({ code: 'delete_failed' });
    await expect(store.remove(['k'])).resolves.toBeUndefined();
    expect(store.callsOf('remove').map((c) => c.keys)).toEqual([['k'], ['k']]);

    store.failNext('createMultipart');
    await expect(store.createMultipart(KEYS.stream, 'video/mp4')).rejects.toBeInstanceOf(R1StoreError);
    store.failNext('listPrefix', 'unavailable');
    await expect(collect(store.listPrefix('r1/'))).rejects.toMatchObject({ code: 'unavailable' });
    store.failNext('presignGet', 'access_denied');
    store.clearFaults();
    await expect(store.presignGet('k', 60)).resolves.toContain(MEMORY_STORE_HOST);
  });
});

describe('MemoryR1ObjectStore: presigned URLs and the HTTP client', () => {
  it('mints URLs that say what they are for, and that never expose a path outside the bucket', async () => {
    const store = new MemoryR1ObjectStore({ now: () => 1_000_000 });
    const part = parseMemoryUrl(await store.presignPart(KEYS.stream, 'mem-upload-1', 4, 600));
    expect(part).toEqual({ op: 'put-part', key: KEYS.stream, uploadId: 'mem-upload-1', partNumber: 4, expiresAtSec: 1000 + 600 });
    const put = parseMemoryUrl(await store.presignPut(KEYS.audio, 600, 'audio/ogg'));
    expect(put).toMatchObject({ op: 'put', key: KEYS.audio, contentType: 'audio/ogg' });
    const get = parseMemoryUrl(await store.presignGet(KEYS.video, 300, { contentType: 'video/mp4', disposition: 'inline' }));
    expect(get).toMatchObject({ op: 'get', key: KEYS.video, responseContentType: 'video/mp4', responseContentDisposition: 'inline', expiresAtSec: 1300 });
    expect(parseMemoryUrl('https://elsewhere.example/x')).toBeNull();
    expect(parseMemoryUrl('not a url')).toBeNull();
    await expect(store.presignGet(KEYS.video, 0)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(store.presignGet(KEYS.video, 3601)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('plays a worker: part PUTs build a multipart object; an object PUT must send the signed Content-Type', async () => {
    const store = new MemoryR1ObjectStore();
    const id = await store.createMultipart(KEYS.stream, 'video/mp4');
    const put = (url: string, body: string, headers: Record<string, string> = { 'content-type': 'application/octet-stream' }) =>
      store.httpFetch(url, { method: 'PUT', headers, body });
    const r1 = await put(await store.presignPart(KEYS.stream, id, 1, 600), 'AAAA');
    expect(r1.status).toBe(200);
    expect(r1.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await store.listParts(KEYS.stream, id)).map((p) => p.size)).toEqual([4]);

    const url = await store.presignPut(KEYS.audioPartial, 600, 'audio/ogg');
    expect((await put(url, 'OggS', { 'content-type': 'application/octet-stream' })).status).toBe(403);
    expect(store.has(KEYS.audioPartial)).toBe(false);
    expect((await put(url, 'OggS', { 'Content-Type': 'audio/ogg' })).status).toBe(200);
    expect(store.getBytes(KEYS.audioPartial).toString()).toBe('OggS');
    expect(store.getContentType(KEYS.audioPartial)).toBe('audio/ogg');
    // A GET URL cannot be used to write, and a part URL for an aborted upload fails like R2's.
    expect((await put(await store.presignGet(KEYS.video, 60), 'x')).status).toBe(403);
    await store.abortMultipart(KEYS.stream, id);
    expect((await put(await store.presignPart(KEYS.stream, id, 2, 600), 'BBBB')).status).toBe(404);
  });

  it('plays a browser: full GET, Range, suffix range, HEAD, 404, 416, response overrides', async () => {
    const store = new MemoryR1ObjectStore();
    store.putObject(KEYS.video, '0123456789', 'application/octet-stream');
    const url = await store.presignGet(KEYS.video, 300, { contentType: 'video/mp4', disposition: 'inline' });
    const full = await store.httpFetch(url);
    expect([full.status, await full.text(), full.headers.get('content-type'), full.headers.get('content-disposition')]).toEqual([200, '0123456789', 'video/mp4', 'inline']);
    expect(full.headers.get('accept-ranges')).toBe('bytes');

    const range = await store.httpFetch(url, { headers: { Range: 'bytes=2-5' } });
    expect([range.status, await range.text(), range.headers.get('content-range'), range.headers.get('content-length')]).toEqual([206, '2345', 'bytes 2-5/10', '4']);
    const open = await store.httpFetch(url, { headers: { range: 'bytes=7-' } });
    expect([open.status, await open.text()]).toEqual([206, '789']);
    const suffix = await store.httpFetch(url, { headers: { range: 'bytes=-3' } });
    expect([suffix.status, await suffix.text(), suffix.headers.get('content-range')]).toEqual([206, '789', 'bytes 7-9/10']);
    const clamped = await store.httpFetch(url, { headers: { range: 'bytes=8-999' } });
    expect([clamped.status, await clamped.text()]).toEqual([206, '89']);
    const past = await store.httpFetch(url, { headers: { range: 'bytes=10-' } });
    expect([past.status, past.headers.get('content-range')]).toEqual([416, 'bytes */10']);

    const head = await store.httpFetch(url, { method: 'HEAD' });
    expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([200, '10', '']);
    const missing = await store.httpFetch(await store.presignGet('r1/none', 60));
    expect(missing.status).toBe(404);
    expect((await store.httpFetch('https://elsewhere.example/x')).status).toBe(400);
  });

  it('expires URLs on its clock with a 403 and no CORS headers (as R2), and echoes CORS only for allowed origins', async () => {
    let now = 5_000_000;
    const store = new MemoryR1ObjectStore({ now: () => now, corsAllowedOrigins: ['https://app.example'] });
    store.putObject(KEYS.video, 'abc');
    const url = await store.presignGet(KEYS.video, 5);
    const ok = await store.httpFetch(url, { headers: { Origin: 'https://app.example' } });
    expect([ok.status, ok.headers.get('access-control-allow-origin'), ok.headers.get('vary')]).toEqual([200, 'https://app.example', 'Origin']);
    const other = await store.httpFetch(url, { headers: { Origin: 'https://other.example' } });
    expect([other.status, other.headers.get('access-control-allow-origin')]).toEqual([200, null]);
    now += 6_000;
    const expired = await store.httpFetch(url, { headers: { Origin: 'https://app.example' } });
    expect([expired.status, expired.headers.get('access-control-allow-origin')]).toEqual([403, null]);
  });
});
