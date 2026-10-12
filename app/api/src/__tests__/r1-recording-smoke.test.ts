import { describe, expect, it, vi } from 'vitest';
import { runSmoke, type LifecycleResult, type SmokeDeps } from '../../scripts/r1-recording-smoke.js';
import { getR1RecordingConfig, type R1RecordingConfig } from '../lib/r1/recording/config.js';
import { MemoryR1ObjectStore } from '../lib/r1/recording/memory-store.js';

const KEY_ID = 'AKIAFAKEFAKEFAKEFAKE';
const SECRET = 'fake-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const ORIGIN = 'https://ib-ik-project-hello.vercel.app';
const validEnv = {
  R1_RECORDING_S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  R1_RECORDING_S3_REGION: 'auto',
  R1_RECORDING_S3_BUCKET: 'ik-r1-recordings',
  R1_RECORDING_S3_ACCESS_KEY_ID: KEY_ID,
  R1_RECORDING_S3_SECRET_ACCESS_KEY: SECRET,
};

function rig(options: { cors?: string[]; lifecycle?: LifecycleResult } = {}) {
  let now = 10_000_000;
  const store = new MemoryR1ObjectStore({ now: () => now, corsAllowedOrigins: options.cors ?? [ORIGIN] });
  const lines: string[] = [];
  const fetchImpl = vi.fn((url: string, init: Parameters<NonNullable<SmokeDeps['fetchImpl']>>[1]) => store.httpFetch(url, init));
  const deps: SmokeDeps = {
    getConfig: () => getR1RecordingConfig(validEnv),
    createStore: () => store,
    fetchImpl,
    sleep: async (ms) => {
      now += ms;
    },
    lifecycle: async () => options.lifecycle ?? { status: 'denied' },
    out: (line) => lines.push(line),
    randomId: () => '0011223344556677',
  };
  return { store, lines, deps, fetchImpl };
}

describe('r1-recording-smoke: not configured', () => {
  it('prints a usage line and exits 2 without creating a store or touching the network', async () => {
    const createStore = vi.fn();
    const fetchImpl = vi.fn();
    const lines: string[] = [];
    const code = await runSmoke([], {
      getConfig: () => getR1RecordingConfig({}),
      createStore,
      fetchImpl,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/^usage: .*R1_RECORDING_S3_ENDPOINT.*npx tsx scripts\/r1-recording-smoke\.ts/);
    expect(lines.join('\n')).toContain('not configured');
    expect(createStore).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a malformed configuration is also exit 2, naming the variable but not its value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const lines: string[] = [];
      const createStore = vi.fn();
      const code = await runSmoke([], {
        getConfig: () => getR1RecordingConfig({ ...validEnv, R1_RECORDING_S3_BUCKET: 'Bad_Bucket' }),
        createStore,
        out: (l) => lines.push(l),
      });
      expect(code).toBe(2);
      expect(lines.join('\n')).toContain('R1_RECORDING_S3_BUCKET');
      expect(lines.join('\n')).not.toContain('Bad_Bucket');
      expect(createStore).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reads the environment by default (no variables -> exit 2 offline)', async () => {
    const names = Object.keys(validEnv) as Array<keyof typeof validEnv>;
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
    try {
      const lines: string[] = [];
      await expect(runSmoke([], { out: (l) => lines.push(l) })).resolves.toBe(2);
    } finally {
      for (const n of names) if (saved[n] !== undefined) process.env[n] = saved[n];
    }
  });
});

describe('r1-recording-smoke: a full run against a store that behaves like R2', () => {
  it('passes every item, skips the lifecycle read-back when the token cannot read it, and leaves nothing behind', async () => {
    const { store, lines, deps, fetchImpl } = rig();
    const code = await runSmoke([], deps);
    const text = lines.join('\n');
    expect(text, text).not.toMatch(/^FAIL/m);
    expect(code).toBe(0);
    for (const id of [
      'multipart-create',
      'presigned-upload-part x3 (bare PUT)',
      'part-replacement',
      'prefix-complete-after-crash',
      'head',
      'range-get-206',
      'cors',
      'expiry',
      'presigned-put-object',
      'abort + empty ListMultipartUploads',
      'cleanup',
    ]) {
      expect(lines.some((l) => l.startsWith(`PASS ${id}`)), id).toBe(true);
    }
    expect(lines.find((l) => l.startsWith('SKIP lifecycle read-back'))).toContain('wrangler r2 bucket lifecycle list');
    expect(lines[lines.length - 1]).toBe('RESULT: 11 pass, 0 fail, 1 skipped');
    // Everything it wrote is gone, including open uploads.
    expect(store.objectKeys()).toEqual([]);
    expect(store.openUploadIds()).toEqual([]);
    // The worker-style traffic really happened: 4 part PUTs (1,2,2',3,5 => 5) + object PUTs + GETs.
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'PUT').length).toBeGreaterThanOrEqual(8);
    // Only the documented prefix was touched.
    expect(store.calls.filter((c) => c.key).every((c) => c.key!.startsWith('r1/smoke/0011223344556677/'))).toBe(true);
  });

  it('never prints a URL, a key, an upload id or a credential', async () => {
    const { lines, deps } = rig();
    await runSmoke([], deps);
    const text = lines.join('\n');
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('memory.invalid');
    expect(text).not.toContain('x-mem-');
    expect(text).not.toContain('mem-upload');
    expect(text).not.toContain('r1/smoke');
    expect(text).not.toContain(KEY_ID);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('0011223344556677');
  });

  it('verifies the lifecycle rules when the token can read them', async () => {
    const good = rig({ lifecycle: { status: 'ok', rules: [{ prefix: 'r1/', expireDays: 97 }, { prefix: 'r1/', abortMultipartDays: 1 }] } });
    expect(await runSmoke([], good.deps)).toBe(0);
    expect(good.lines.some((l) => l.startsWith('PASS lifecycle read-back'))).toBe(true);

    const wrong = rig({ lifecycle: { status: 'ok', rules: [{ prefix: 'r1/', expireDays: 30 }] } });
    expect(await runSmoke([], wrong.deps)).toBe(1);
    expect(wrong.lines.find((l) => l.startsWith('FAIL lifecycle read-back'))).toContain('step O4');

    const broken = rig({ lifecycle: { status: 'error' } });
    expect(await runSmoke([], broken.deps)).toBe(0);
    expect(broken.lines.find((l) => l.startsWith('SKIP lifecycle read-back'))).toBeTruthy();
  });

  it('reports a missing CORS rule as a FAIL that points at step O5', async () => {
    const { lines, deps } = rig({ cors: [] });
    expect(await runSmoke([], deps)).toBe(1);
    expect(lines.find((l) => l.startsWith('FAIL cors'))).toContain('step O5');
  });

  it('accepts a different web origin with --origin=', async () => {
    const { lines, deps } = rig({ cors: ['https://staging.example'] });
    expect(await runSmoke(['--origin=https://staging.example'], deps)).toBe(0);
    expect(lines.some((l) => l.startsWith('PASS cors'))).toBe(true);
  });

  it('after a mid-run failure the dependent items are SKIPped, independent ones still run, and cleanup still removes everything', async () => {
    const { store, lines, deps } = rig();
    store.failNext('listParts', 'unavailable'); // fails inside part-replacement
    expect(await runSmoke([], deps)).toBe(1);
    const status = (id: string): string | undefined => lines.find((l) => l.includes(id))?.split(' ')[0];
    expect(status('part-replacement')).toBe('FAIL');
    expect(lines.find((l) => l.includes('part-replacement'))).toContain('store error unavailable');
    expect(status('prefix-complete-after-crash')).toBe('SKIP');
    expect(status('head')).toBe('SKIP');
    expect(status('range-get-206')).toBe('SKIP');
    expect(status('presigned-put-object')).toBe('PASS');
    expect(status('cleanup')).toBe('PASS');
    expect(store.objectKeys()).toEqual([]);
    expect(store.openUploadIds()).toEqual([]);
  });

  it('a cleanup that cannot finish is a FAIL, never silent', async () => {
    const { store, lines, deps } = rig();
    store.failNext('remove', 'unavailable', { times: 2 });
    expect(await runSmoke([], deps)).toBe(1);
    expect(lines.find((l) => l.includes('cleanup'))).toMatch(/^FAIL/);
  });
});
