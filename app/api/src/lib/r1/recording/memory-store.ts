/**
 * An in-memory {@link R1ObjectStore} with real multipart semantics and failure injection. Every API
 * test of the recording feature (routes, finalize, erase, sweep, DSAR, staff playback) injects this
 * instead of the S3 adapter, and `httpFetch` lets a test play the WORKER: it takes a presigned URL
 * the code under test produced and PUTs bytes to it, or plays a browser GET (with Range, response
 * overrides, expiry and a CORS echo) against it.
 *
 * Emulated like R2/S3:
 *  - a part number re-uploaded REPLACES the part;
 *  - CompleteMultipartUpload needs strictly ascending parts that exist with matching ETags, all but
 *    the last the SAME size (and, when `minPartSize` is set, at least that size), and only the listed
 *    parts become the object (a prefix of what was uploaded is valid, the rest is discarded);
 *  - a completed or aborted upload id is gone: complete -> `no_such_upload`, abort -> success;
 *  - presigning never touches the store (like a real presign); the later PUT fails if the upload is gone;
 *  - a presigned PUT whose signed Content-Type does not match is rejected (403), exactly like R2.
 *
 * Not a security boundary and not exported to production code paths: production never imports it.
 */

import { createHash } from 'node:crypto';
import {
  R1StoreError,
  type R1ListedObject,
  type R1MultipartUploadInfo,
  type R1ObjectHead,
  type R1ObjectStore,
  type R1PresignGetOptions,
  type R1StoreErrorCode,
  type R1StoredPart,
} from './store.js';

export type MemoryStoreOp =
  | 'createMultipart'
  | 'presignPart'
  | 'listParts'
  | 'completeMultipart'
  | 'abortMultipart'
  | 'listMultipartUploads'
  | 'presignPut'
  | 'presignGet'
  | 'head'
  | 'read'
  | 'remove'
  | 'listPrefix';

export interface MemoryStoreOptions {
  bucket?: string;
  /** Epoch milliseconds; drives URL expiry and `initiatedAt`. */
  now?: () => number;
  /** When set, every part except the last must be at least this large (R2 enforces 5 MiB). */
  minPartSize?: number;
  /** Origins for which `httpFetch` GET/HEAD echoes `access-control-allow-origin`. */
  corsAllowedOrigins?: string[];
}

export interface MemoryCall {
  op: MemoryStoreOp;
  key?: string;
  prefix?: string;
  uploadId?: string;
  part?: number;
  keys?: string[];
}

interface StoredObject {
  size: number;
  etag: string;
  contentType: string;
  lastModified: number;
  data?: Buffer;
  chunks?: () => AsyncIterable<Uint8Array>;
}
interface StoredPart {
  data: Buffer;
  etag: string;
}
interface Upload {
  key: string;
  contentType: string;
  initiatedAt: number;
  parts: Map<number, StoredPart>;
}
interface Fault {
  op: MemoryStoreOp;
  code: R1StoreErrorCode;
  skip: number;
  remaining: number;
}

export const MEMORY_STORE_HOST = 'r1-recordings.memory.invalid';

const md5 = (data: Uint8Array): Buffer => createHash('md5').update(data).digest();
const toBuffer = (data: Uint8Array | string): Buffer => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
const quoted = (hex: string): string => `"${hex}"`;
const objectEtag = (data: Uint8Array): string => quoted(md5(data).toString('hex'));

/** What a presigned URL minted by this store says. */
export interface ParsedMemoryUrl {
  op: 'put-part' | 'put' | 'get';
  key: string;
  expiresAtSec: number;
  uploadId?: string;
  partNumber?: number;
  /** Signed Content-Type of a `put` URL. */
  contentType?: string;
  /** Signed `response-content-type` of a `get` URL. */
  responseContentType?: string;
  responseContentDisposition?: string;
}

export function parseMemoryUrl(raw: string): ParsedMemoryUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== MEMORY_STORE_HOST) return null;
  const op = url.searchParams.get('x-mem-op');
  const exp = Number(url.searchParams.get('x-mem-exp'));
  if ((op !== 'put-part' && op !== 'put' && op !== 'get') || !Number.isFinite(exp)) return null;
  const segments = url.pathname.split('/').slice(2); // ['', bucket, ...key]
  const parsed: ParsedMemoryUrl = { op, key: segments.map(decodeURIComponent).join('/'), expiresAtSec: exp };
  const uploadId = url.searchParams.get('uploadId');
  if (uploadId) parsed.uploadId = uploadId;
  const part = url.searchParams.get('partNumber');
  if (part) parsed.partNumber = Number(part);
  const ct = url.searchParams.get('x-mem-ct');
  if (ct) parsed.contentType = ct;
  const rct = url.searchParams.get('response-content-type');
  if (rct) parsed.responseContentType = rct;
  const rcd = url.searchParams.get('response-content-disposition');
  if (rcd) parsed.responseContentDisposition = rcd;
  return parsed;
}

export class MemoryR1ObjectStore implements R1ObjectStore {
  readonly bucket: string;
  readonly calls: MemoryCall[] = [];
  private readonly objects = new Map<string, StoredObject>();
  private readonly uploads = new Map<string, Upload>();
  private readonly faults: Fault[] = [];
  private readonly clock: () => number;
  private readonly minPartSize: number;
  private readonly cors: Set<string>;
  private uploadCounter = 0;

  constructor(options: MemoryStoreOptions = {}) {
    this.bucket = options.bucket ?? 'ik-r1-recordings';
    this.clock = options.now ?? Date.now;
    this.minPartSize = options.minPartSize ?? 0;
    this.cors = new Set(options.corsAllowedOrigins ?? []);
  }

  // ---------------------------------------------------------------- test controls

  /** Make the next matching call(s) throw `R1StoreError(code)`: skip `skip` calls, then fail `times`. */
  failNext(op: MemoryStoreOp, code: R1StoreErrorCode = 'unavailable', options: { times?: number; skip?: number } = {}): void {
    this.faults.push({ op, code, skip: options.skip ?? 0, remaining: options.times ?? 1 });
  }
  clearFaults(): void {
    this.faults.length = 0;
  }
  callsOf(op: MemoryStoreOp): MemoryCall[] {
    return this.calls.filter((c) => c.op === op);
  }
  countCalls(op: MemoryStoreOp): number {
    return this.callsOf(op).length;
  }

  /** Seed an object directly (as if a client PUT it). */
  putObject(key: string, data: Uint8Array | string, contentType = 'application/octet-stream'): void {
    const buf = toBuffer(data);
    this.objects.set(key, { size: buf.length, etag: objectEtag(buf), contentType, lastModified: this.clock(), data: buf });
  }
  /** Seed a large object without materialising it: `chunk` repeated until `size` bytes. */
  putRepeating(key: string, size: number, chunk: Uint8Array, contentType = 'application/octet-stream'): void {
    if (chunk.length === 0 || size < 0) throw new RangeError('putRepeating needs a non-empty chunk');
    this.objects.set(key, {
      size,
      etag: quoted(`virtual-${size}-${chunk.length}`),
      contentType,
      lastModified: this.clock(),
      chunks: async function* () {
        let left = size;
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          yield n === chunk.length ? chunk : chunk.subarray(0, n);
          left -= n;
        }
      },
    });
  }
  /** Seed an object backed by a generator (for streaming-memory tests). */
  putVirtual(key: string, size: number, chunks: () => AsyncIterable<Uint8Array>, contentType = 'application/octet-stream', etag?: string): void {
    this.objects.set(key, { size, etag: etag ?? quoted(`virtual-${size}`), contentType, lastModified: this.clock(), chunks });
  }
  /** Upload (or replace) one part directly, as a worker PUT of a presigned part URL would. */
  putPart(uploadId: string, partNumber: number, data: Uint8Array | string): string {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new R1StoreError('no_such_upload', 404);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new R1StoreError('invalid_request', 400);
    const buf = toBuffer(data);
    const etag = objectEtag(buf);
    upload.parts.set(partNumber, { data: buf, etag });
    return etag;
  }
  /** Simulate an external deletion (a lifecycle rule, an operator): the object just disappears. */
  disappear(key: string): void {
    this.objects.delete(key);
  }
  has(key: string): boolean {
    return this.objects.has(key);
  }
  objectKeys(): string[] {
    return [...this.objects.keys()].sort();
  }
  /** The full body of a small object (throws for a virtual one). */
  getBytes(key: string): Buffer {
    const o = this.objects.get(key);
    if (!o?.data) throw new Error('no materialised object');
    return o.data;
  }
  getContentType(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
  }
  openUploadIds(): string[] {
    return [...this.uploads.keys()];
  }
  uploadKey(uploadId: string): string | undefined {
    return this.uploads.get(uploadId)?.key;
  }
  uploadContentType(uploadId: string): string | undefined {
    return this.uploads.get(uploadId)?.contentType;
  }

  // ---------------------------------------------------------------- R1ObjectStore

  async createMultipart(key: string, contentType: string): Promise<string> {
    this.enter({ op: 'createMultipart', key });
    this.uploadCounter += 1;
    const uploadId = `mem-upload-${this.uploadCounter}`;
    this.uploads.set(uploadId, { key, contentType, initiatedAt: this.clock(), parts: new Map() });
    return uploadId;
  }

  async presignPart(key: string, uploadId: string, part: number, ttlSec: number): Promise<string> {
    this.enter({ op: 'presignPart', key, uploadId, part });
    return this.mint('put-part', key, ttlSec, { uploadId, partNumber: String(part) });
  }

  async listParts(key: string, uploadId: string): Promise<R1StoredPart[]> {
    this.enter({ op: 'listParts', key, uploadId });
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new R1StoreError('no_such_upload', 404);
    return [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([n, p]) => ({ n, size: p.data.length, etag: p.etag }));
  }

  async completeMultipart(key: string, uploadId: string, parts: ReadonlyArray<{ n: number; etag: string }>): Promise<void> {
    this.enter({ op: 'completeMultipart', key, uploadId });
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new R1StoreError('no_such_upload', 404);
    if (parts.length === 0) throw new R1StoreError('invalid_request', 400);
    let previous = 0;
    const buffers: Buffer[] = [];
    const digests: Buffer[] = [];
    for (const [index, wanted] of parts.entries()) {
      if (!Number.isInteger(wanted.n) || wanted.n <= previous) throw new R1StoreError('invalid_request', 400); // InvalidPartOrder
      previous = wanted.n;
      const stored = upload.parts.get(wanted.n);
      if (!stored || stored.etag.replace(/"/g, '') !== wanted.etag.replace(/"/g, '')) throw new R1StoreError('invalid_request', 400); // InvalidPart
      const last = index === parts.length - 1;
      if (!last && this.minPartSize > 0 && stored.data.length < this.minPartSize) throw new R1StoreError('invalid_request', 400); // EntityTooSmall
      buffers.push(stored.data);
      digests.push(md5(stored.data));
    }
    const firstSize = buffers[0]!.length;
    for (let i = 1; i < buffers.length - 1; i += 1) {
      if (buffers[i]!.length !== firstSize) throw new R1StoreError('invalid_request', 400); // R2: uniform part size
    }
    if (buffers.length > 1 && buffers[buffers.length - 1]!.length > firstSize) throw new R1StoreError('invalid_request', 400);
    const data = Buffer.concat(buffers);
    this.objects.set(key, {
      size: data.length,
      etag: quoted(`${createHash('md5').update(Buffer.concat(digests)).digest('hex')}-${parts.length}`),
      contentType: upload.contentType,
      lastModified: this.clock(),
      data,
    });
    this.uploads.delete(uploadId);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    this.enter({ op: 'abortMultipart', key, uploadId });
    const upload = this.uploads.get(uploadId);
    if (upload && upload.key === key) this.uploads.delete(uploadId);
  }

  async *listMultipartUploads(prefix: string): AsyncGenerator<R1MultipartUploadInfo> {
    this.enter({ op: 'listMultipartUploads', prefix });
    const rows = [...this.uploads.entries()]
      .filter(([, u]) => u.key.startsWith(prefix))
      .sort((a, b) => (a[1].key === b[1].key ? a[1].initiatedAt - b[1].initiatedAt : a[1].key < b[1].key ? -1 : 1));
    for (const [uploadId, u] of rows) yield { key: u.key, uploadId, initiatedAt: new Date(u.initiatedAt) };
  }

  async presignPut(key: string, ttlSec: number, contentType: string): Promise<string> {
    this.enter({ op: 'presignPut', key });
    return this.mint('put', key, ttlSec, { 'x-mem-ct': contentType });
  }

  async presignGet(key: string, ttlSec: number, options: R1PresignGetOptions = {}): Promise<string> {
    this.enter({ op: 'presignGet', key });
    const extra: Record<string, string> = {};
    if (options.contentType) extra['response-content-type'] = options.contentType;
    if (options.disposition) extra['response-content-disposition'] = options.disposition;
    return this.mint('get', key, ttlSec, extra);
  }

  async head(key: string): Promise<R1ObjectHead | null> {
    this.enter({ op: 'head', key });
    const o = this.objects.get(key);
    return o ? { bytes: o.size, etag: o.etag, contentType: o.contentType } : null;
  }

  async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    this.enter({ op: 'read', key });
    const o = this.objects.get(key);
    if (!o) throw new R1StoreError('not_found', 404);
    return this.bodyOf(o);
  }

  async remove(keys: string[]): Promise<void> {
    this.enter({ op: 'remove', keys: [...keys] });
    for (const key of keys) this.objects.delete(key);
  }

  async *listPrefix(prefix: string): AsyncGenerator<R1ListedObject> {
    this.enter({ op: 'listPrefix', prefix });
    for (const key of [...this.objects.keys()].sort()) {
      if (key.startsWith(prefix)) yield { key, bytes: this.objects.get(key)!.size };
    }
  }

  // ---------------------------------------------------------------- HTTP emulation of presigned URLs

  /**
   * Play a client against a presigned URL minted by this store: PUT (worker), GET/HEAD (browser, with
   * Range, signed response overrides and a CORS echo). Returns a real `Response`.
   */
  async httpFetch(
    input: string | URL,
    init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string | null } = {},
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = lowerCase(init.headers ?? {});
    const parsed = parseMemoryUrl(String(input));
    if (!parsed) return new Response(null, { status: 400 });
    // Expired: R2 answers 403 and, like the real thing, adds no CORS headers.
    if (parsed.expiresAtSec * 1000 <= this.clock()) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });

    if (parsed.op === 'put-part') {
      if (method !== 'PUT') return new Response(null, { status: 403 });
      const upload = parsed.uploadId ? this.uploads.get(parsed.uploadId) : undefined;
      if (!upload || upload.key !== parsed.key) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
      const etag = this.putPart(parsed.uploadId!, parsed.partNumber ?? 0, init.body ?? '');
      return new Response(null, { status: 200, headers: { etag } });
    }
    if (parsed.op === 'put') {
      if (method !== 'PUT') return new Response(null, { status: 403 });
      // The Content-Type is part of the signature: a different one is SignatureDoesNotMatch.
      if (parsed.contentType !== undefined && headers['content-type'] !== parsed.contentType) {
        return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
      }
      this.putObject(parsed.key, init.body ?? '', parsed.contentType ?? 'application/octet-stream');
      return new Response(null, { status: 200, headers: { etag: this.objects.get(parsed.key)!.etag } });
    }
    // get
    if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 403 });
    const o = this.objects.get(parsed.key);
    const corsOrigin = headers.origin && this.cors.has(headers.origin) ? headers.origin : undefined;
    const cors: Record<string, string> = corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'Origin' } : {};
    if (!o) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: cors });
    const base: Record<string, string> = {
      ...cors,
      'accept-ranges': 'bytes',
      etag: o.etag,
      'content-type': parsed.responseContentType ?? o.contentType,
    };
    if (parsed.responseContentDisposition) base['content-disposition'] = parsed.responseContentDisposition;
    const range = parseRange(headers.range, o.size);
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${o.size}` } });
    const [start, end] = range ?? [0, o.size - 1];
    const length = o.size === 0 ? 0 : end - start + 1;
    const status = range ? 206 : 200;
    const out: Record<string, string> = { ...base, 'content-length': String(length) };
    if (range) out['content-range'] = `bytes ${start}-${end}/${o.size}`;
    if (method === 'HEAD') return new Response(null, { status, headers: out });
    return new Response(await collect(this.bodyOf(o), start, length), { status, headers: out });
  }

  // ---------------------------------------------------------------- internals

  private enter(call: MemoryCall): void {
    this.calls.push(call);
    for (const fault of this.faults) {
      if (fault.op !== call.op || fault.remaining <= 0) continue;
      if (fault.skip > 0) {
        fault.skip -= 1;
        continue;
      }
      fault.remaining -= 1;
      throw new R1StoreError(fault.code);
    }
  }

  private mint(op: 'put-part' | 'put' | 'get', key: string, ttlSec: number, params: Record<string, string>): string {
    if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > 3600) throw new R1StoreError('invalid_request');
    const path = key.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`https://${MEMORY_STORE_HOST}/${this.bucket}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('x-mem-op', op);
    url.searchParams.set('x-mem-exp', String(Math.floor(this.clock() / 1000) + ttlSec));
    return url.toString();
  }

  private bodyOf(o: StoredObject): AsyncIterable<Uint8Array> {
    if (o.chunks) return o.chunks();
    const data = o.data ?? Buffer.alloc(0);
    return (async function* () {
      for (let at = 0; at < data.length; at += 65536) yield data.subarray(at, at + 65536);
    })();
  }
}

function lowerCase(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Single-range `bytes=a-b | a- | -n`; `null` = no Range header; `'unsatisfiable'` = 416. */
function parseRange(header: string | undefined, size: number): [number, number] | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? 'unsatisfiable' : [start, end];
}

async function collect(body: AsyncIterable<Uint8Array>, start: number, length: number): Promise<Buffer<ArrayBuffer>> {
  const out = Buffer.alloc(length);
  let position = 0; // absolute offset of the next chunk
  let written = 0;
  for await (const chunk of body) {
    const chunkStart = position;
    position += chunk.length;
    if (position <= start) continue;
    const from = Math.max(0, start - chunkStart);
    const take = Math.min(chunk.length - from, length - written);
    out.set(chunk.subarray(from, from + take), written);
    written += take;
    if (written >= length) break;
  }
  return out;
}
