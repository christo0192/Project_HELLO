/**
 * S0-D smoke test for the R1 recording bucket (roadmap section 13, step O7). Opt-in and manual: it is
 * never run by CI and it needs the real R2 credentials, which it reads from the same five variables
 * the API reads:
 *
 *   R1_RECORDING_S3_ENDPOINT  R1_RECORDING_S3_REGION (auto)  R1_RECORDING_S3_BUCKET
 *   R1_RECORDING_S3_ACCESS_KEY_ID  R1_RECORDING_S3_SECRET_ACCESS_KEY
 *
 *   npx tsx scripts/r1-recording-smoke.ts [--origin=https://ib-ik-project-hello.vercel.app]
 *
 * Without a complete, valid configuration it prints a usage line and exits 2 BEFORE any network use.
 * Everything it writes goes under `r1/smoke/<random>/` and is deleted (and verified gone) at the end,
 * even after a failure. It prints one PASS / FAIL / SKIP line per item and NEVER a URL, key,
 * credential or provider message; exit code 0 = no FAIL, 1 = at least one FAIL, 2 = not configured.
 *
 * What it proves about R2 (each item is the unproven assumption the design rests on):
 *   presigned UploadPart x3 with a bare PUT | ListMultipartUploads names the open upload by exactly
 *   the UploadId CreateMultipartUpload returned (the sweep's test) | part replacement |
 *   prefix-complete after a simulated crash (parts 1-3 + a stray part 5, completed with 1-3) | HEAD |
 *   Range GET (206) across a part boundary with a signed response-content-type | CORS echo for the
 *   web origin and none for another |
 *   a whole-object presigned PUT that signs Content-Type | abort + empty ListMultipartUploads |
 *   5 s expiry -> 403 | lifecycle read-back (SKIP when the token cannot read it) | cleanup.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getR1RecordingConfig,
  PART_SIZE,
  R1_RECORDING_S3_VARIABLES,
  type R1RecordingConfig,
} from '../src/lib/r1/recording/config.js';
import { AUDIO_PARTIAL_FILE, STREAM_FILE } from '../src/lib/r1/recording/keys.js';
import { isR1StoreError, type R1ObjectStore } from '../src/lib/r1/recording/store.js';

export interface LifecycleResult {
  /** `denied` = the token cannot read bucket configuration (expected for an object-scoped token). */
  status: 'ok' | 'denied' | 'error';
  rules?: Array<{ prefix: string; expireDays?: number; abortMultipartDays?: number }>;
}

export interface SmokeDeps {
  getConfig?: () => R1RecordingConfig;
  createStore?: (config: Extract<R1RecordingConfig, { enabled: true }>) => Promise<R1ObjectStore> | R1ObjectStore;
  fetchImpl?: (url: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | null }) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  lifecycle?: (config: Extract<R1RecordingConfig, { enabled: true }>) => Promise<LifecycleResult>;
  out?: (line: string) => void;
  randomId?: () => string;
}

const DEFAULT_ORIGIN = 'https://ib-ik-project-hello.vercel.app';
const OTHER_ORIGIN = 'https://not-allowed.example';
const USAGE =
  'usage: export R1_RECORDING_S3_ENDPOINT, R1_RECORDING_S3_REGION=auto, R1_RECORDING_S3_BUCKET, ' +
  'R1_RECORDING_S3_ACCESS_KEY_ID and R1_RECORDING_S3_SECRET_ACCESS_KEY, then: ' +
  'npx tsx scripts/r1-recording-smoke.ts [--origin=https://<web origin>]';

type Outcome = 'PASS' | 'FAIL' | 'SKIP';

/** A short, value-free description of a thrown error (never `error.message`: it may contain a URL). */
function describe(error: unknown): string {
  if (isR1StoreError(error)) return `store error ${error.code}${error.status ? ` (http ${error.status})` : ''}`;
  return error instanceof Error ? `unexpected ${error.name}` : 'unexpected error';
}

async function defaultLifecycle(config: Extract<R1RecordingConfig, { enabled: true }>): Promise<LifecycleResult> {
  const s3 = await import('@aws-sdk/client-s3');
  const client = new s3.S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
    maxAttempts: 2,
  });
  try {
    const out = await client.send(new s3.GetBucketLifecycleConfigurationCommand({ Bucket: config.s3.bucket }));
    return {
      status: 'ok',
      rules: (out.Rules ?? []).map((r) => ({
        prefix: r.Filter?.Prefix ?? r.Prefix ?? '',
        ...(r.Expiration?.Days !== undefined ? { expireDays: r.Expiration.Days } : {}),
        ...(r.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== undefined
          ? { abortMultipartDays: r.AbortIncompleteMultipartUpload.DaysAfterInitiation }
          : {}),
      })),
    };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return { status: status === 403 || status === 401 || status === 501 || status === 405 ? 'denied' : 'error' };
  }
}

export async function runSmoke(argv: string[], deps: SmokeDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const config = (deps.getConfig ?? (() => getR1RecordingConfig()))();
  if (!config.enabled) {
    out(USAGE);
    out(
      config.status === 'invalid'
        ? `configuration problem: ${config.reason}`
        : `not configured: none of ${R1_RECORDING_S3_VARIABLES.join(', ')} is set`,
    );
    return 2;
  }
  const originArg = argv.find((a) => a.startsWith('--origin='));
  const origin = originArg ? originArg.slice('--origin='.length) : DEFAULT_ORIGIN;

  const store = await (deps.createStore
    ? deps.createStore(config)
    : (async () => (await import('../src/lib/r1/recording/s3-store.js')).createS3Store(config.s3))());
  const doFetch =
    deps.fetchImpl ?? ((url, init) => fetch(url, { method: init.method, headers: init.headers, body: (init.body ?? undefined) as BodyInit | undefined }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lifecycle = deps.lifecycle ?? defaultLifecycle;
  const runId = (deps.randomId ?? (() => randomBytes(8).toString('hex')))();
  const prefix = `r1/smoke/${runId}/`;
  const streamKey = prefix + STREAM_FILE;
  const oggKey = prefix + AUDIO_PARTIAL_FILE;
  const abortKey = `${prefix}abort-me.bin`;

  const counts: Record<Outcome, number> = { PASS: 0, FAIL: 0, SKIP: 0 };
  const report = (outcome: Outcome, id: string, detail = ''): void => {
    counts[outcome] += 1;
    out(`${outcome} ${id}${detail ? ` - ${detail}` : ''}`);
  };
  /** Run one item; a thrown error is a FAIL with a value-free description and the run continues. */
  async function item(id: string, body: () => Promise<string | void>): Promise<boolean> {
    try {
      const detail = await body();
      report('PASS', id, detail ?? '');
      return true;
    } catch (error) {
      report('FAIL', id, error instanceof SmokeFailure ? error.message : describe(error));
      return false;
    }
  }
  /** Like {@link item}, but reported as SKIP when an earlier item it depends on did not pass. */
  async function after(ok: boolean, id: string, body: () => Promise<string | void>): Promise<boolean> {
    if (ok) return item(id, body);
    report('SKIP', id, 'an earlier item failed');
    return false;
  }
  const expect = (condition: boolean, message: string): void => {
    if (!condition) throw new SmokeFailure(message);
  };

  const part1 = randomBytes(PART_SIZE);
  const part2a = randomBytes(PART_SIZE);
  const part2b = randomBytes(PART_SIZE);
  const part3 = randomBytes(1_048_576);
  const part5 = randomBytes(PART_SIZE);
  const total = PART_SIZE * 2 + part3.length;
  let uploadId = '';
  const etags: Record<number, string> = {};

  const putPart = async (n: number, data: Buffer): Promise<string> => {
    const url = await store.presignPart(streamKey, uploadId, n, 600);
    const res = await doFetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: data });
    expect(res.status === 200, `part ${n} PUT answered http ${res.status}`);
    const etag = res.headers.get('etag');
    expect(!!etag, `part ${n} PUT returned no ETag`);
    return etag as string;
  };

  try {
    const created = await item('multipart-create', async () => {
      uploadId = await store.createMultipart(streamKey, 'video/mp4');
      expect(uploadId.length > 0, 'no upload id');
    });
    const uploaded = await after(created, 'presigned-upload-part x3 (bare PUT)', async () => {
      etags[1] = await putPart(1, part1);
      etags[2] = await putPart(2, part2a);
      etags[3] = await putPart(3, part3);
      return `parts 1-3 stored (${total} bytes)`;
    });
    // The r1.sweep orphan scan keeps a recording's open upload only when the listed UploadId string
    // equals the one CreateMultipartUpload returned (the row's `upload_id`). Session 482cb480 lost its
    // upload mid-call (2026-10-21); this confirms or rules out a mismatch on real R2. Read-only.
    await after(uploaded, 'list-multipart-uploads (the open upload is listed under the exact UploadId)', async () => {
      const listed: Array<{ uploadId: string; initiatedAt: Date }> = [];
      for await (const u of store.listMultipartUploads(prefix)) if (u.key === streamKey) listed.push(u);
      expect(listed.length === 1, `${listed.length} open upload(s) listed for the stream key (expected 1)`);
      const id = listed[0]!.uploadId;
      if (id !== uploadId) {
        let decodedEqual = false;
        try {
          decodedEqual = decodeURIComponent(id) === uploadId || id === decodeURIComponent(uploadId);
        } catch {
          /* not percent-encoded */
        }
        throw new SmokeFailure(
          `the listed UploadId differs from the created one (${decodedEqual ? 'equal after URL-decoding' : `${id.length} vs ${uploadId.length} characters`}): ` +
          'the r1.sweep orphan scan would abort a live recording\'s upload',
        );
      }
      expect(listed[0]!.initiatedAt.getTime() > 0, 'the listing carries no Initiated time (the sweep would treat the upload as old)');
      return 'listed UploadId equals the created one; Initiated present';
    });
    const replaced = await after(uploaded, 'part-replacement', async () => {
      const next = await putPart(2, part2b);
      expect(next !== etags[2], 're-uploaded part 2 kept the old ETag');
      const parts = await store.listParts(streamKey, uploadId);
      expect(parts.length === 3 && parts.every((p, i) => p.n === i + 1), `ListParts returned ${parts.length} parts`);
      expect(parts[1]!.etag === next && parts[1]!.size === PART_SIZE, 'ListParts does not show the replacement');
      etags[2] = next;
      return 'same part number replaced, ListParts shows the new ETag';
    });
    const completed = await after(replaced, 'prefix-complete-after-crash', async () => {
      etags[5] = await putPart(5, part5); // the worker "crashed" after part 3: part 4 never arrives, a stray 5 exists
      const parts = await store.listParts(streamKey, uploadId);
      expect(parts.map((p) => p.n).join(',') === '1,2,3,5', 'ListParts did not show parts 1,2,3,5');
      await store.completeMultipart(streamKey, uploadId, [1, 2, 3].map((n) => ({ n, etag: etags[n]! })));
      return 'CompleteMultipartUpload accepted parts 1-3 and discarded the stray part 5';
    });
    const headed = await after(completed, 'head', async () => {
      const head = await store.head(streamKey);
      expect(head !== null, 'object missing after complete');
      expect(head!.bytes === total, `size ${head!.bytes} != ${total}`);
      expect(head!.etag.length > 0, 'no ETag');
      return `${head!.bytes} bytes`;
    });
    await after(headed, 'range-get-206 (across a part boundary, signed response-content-type)', async () => {
      const url = await store.presignGet(streamKey, 120, { contentType: 'video/mp4' });
      const from = PART_SIZE - 10;
      const res = await doFetch(url, { method: 'GET', headers: { range: `bytes=${from}-${from + 19}` } });
      expect(res.status === 206, `Range GET answered http ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(Buffer.concat([part1.subarray(PART_SIZE - 10), part2b.subarray(0, 10)])), 'range bytes differ (replacement part missing?)');
      expect((res.headers.get('content-type') ?? '').startsWith('video/mp4'), 'response-content-type override was not applied');
      return '206 with the replaced part bytes';
    });
    await after(headed, 'cors (echo for the web origin, none for another)', async () => {
      const url = await store.presignGet(streamKey, 120, { contentType: 'video/mp4' });
      const allowed = await doFetch(url, { method: 'GET', headers: { range: 'bytes=0-0', origin } });
      expect(allowed.headers.get('access-control-allow-origin') === origin, 'no Access-Control-Allow-Origin echo for the web origin (apply the CORS rule, step O5)');
      const other = await doFetch(url, { method: 'GET', headers: { range: 'bytes=0-0', origin: OTHER_ORIGIN } });
      expect(other.headers.get('access-control-allow-origin') === null, 'another origin was allowed');
      return 'echoed for the web origin only';
    });
    await after(headed, 'expiry (5 s URL -> 403 after expiry)', async () => {
      const url = await store.presignGet(streamKey, 5, { contentType: 'video/mp4' });
      const before = await doFetch(url, { method: 'GET', headers: { range: 'bytes=0-0' } });
      expect(before.status === 206, `fresh URL answered http ${before.status}`);
      await sleep(7000);
      const expired = await doFetch(url, { method: 'GET', headers: { range: 'bytes=0-0' } });
      expect(expired.status === 403, `expired URL answered http ${expired.status}`);
      return 'valid, then 403';
    });
    await item('presigned-put-object (Content-Type is signed)', async () => {
      const url = await store.presignPut(oggKey, 120, 'audio/ogg');
      const wrong = await doFetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('OggS-smoke') });
      expect(wrong.status === 403, `a PUT with another Content-Type answered http ${wrong.status} (expected 403)`);
      const right = await doFetch(url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: Buffer.from('OggS-smoke') });
      expect(right.status === 200, `the PUT with the signed Content-Type answered http ${right.status}`);
      const head = await store.head(oggKey);
      expect(head !== null && head.bytes === 10 && (head.contentType ?? '') === 'audio/ogg', 'stored object does not match what was PUT');
      return 'wrong type refused, signed type stored';
    });
    await item('abort + empty ListMultipartUploads', async () => {
      const id = await store.createMultipart(abortKey, 'application/octet-stream');
      const url = await store.presignPart(abortKey, id, 1, 600);
      const res = await doFetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('abort me') });
      expect(res.status === 200, `part PUT answered http ${res.status}`);
      await store.abortMultipart(abortKey, id);
      await store.abortMultipart(abortKey, id); // a second abort must not fail
      let left = 0;
      for await (const _u of store.listMultipartUploads(prefix)) left += 1;
      expect(left === 0, `${left} multipart upload(s) still listed under the smoke prefix`);
      return 'no uploads listed (the completed and the aborted one are gone)';
    });

    const life = await lifecycle(config);
    if (life.status === 'ok') {
      await item('lifecycle read-back', async () => {
        const rules = life.rules ?? [];
        const expiry = rules.find((r) => r.prefix === 'r1/' && r.expireDays === 97);
        const abort = rules.find((r) => r.prefix === 'r1/' && r.abortMultipartDays === 1);
        expect(!!expiry, 'no rule expiring r1/ after 97 days (step O4)');
        expect(!!abort, 'no rule aborting incomplete multipart uploads under r1/ after 1 day (step O4)');
        return 'r1/ expires at 97 days, incomplete multipart aborted at 1 day';
      });
    } else {
      report(
        'SKIP',
        'lifecycle read-back',
        life.status === 'denied'
          ? 'this token cannot read bucket configuration; run: npx wrangler r2 bucket lifecycle list <bucket>'
          : 'lifecycle could not be read; check it with: npx wrangler r2 bucket lifecycle list <bucket>',
      );
    }
  } finally {
    await item('cleanup (smoke prefix removed and verified)', async () => {
      for await (const u of store.listMultipartUploads(prefix)) await store.abortMultipart(u.key, u.uploadId);
      if (uploadId) await store.abortMultipart(streamKey, uploadId);
      const keys: string[] = [];
      for await (const o of store.listPrefix(prefix)) keys.push(o.key);
      await store.remove(keys);
      let remaining = 0;
      for await (const _o of store.listPrefix(prefix)) remaining += 1;
      let stray = 0;
      for await (const _u of store.listMultipartUploads(prefix)) stray += 1;
      expect(remaining === 0 && stray === 0, `${remaining} object(s) and ${stray} upload(s) remain under the smoke prefix`);
      for (const key of keys) expect((await store.head(key)) === null, 'a deleted object still answers HEAD');
      return `${keys.length} object(s) deleted`;
    });
  }

  out(`RESULT: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skipped`);
  return counts.FAIL > 0 ? 1 : 0;
}

class SmokeFailure extends Error {}

// Run only when executed directly (`tsx scripts/r1-recording-smoke.ts`), not when imported by a test.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runSmoke(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`FAIL smoke aborted - ${describe(error)}`);
      process.exitCode = 1;
    },
  );
}
