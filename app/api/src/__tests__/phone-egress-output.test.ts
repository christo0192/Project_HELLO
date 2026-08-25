/**
 * phone-egress-output.test.ts — the PRODUCTION defaults of the phone egress
 * seam.
 *
 * These are the adapters nothing else exercises: every other phone suite
 * injects a fake, which is correct for testing the ordering but leaves the
 * real bindings unrun. This lane has already recorded the consequence —
 * "cover every seam's default or the feature dies green" — and an egress
 * adapter that throws on first use in production would be discovered by a
 * candidate on a live call, after the disclosure has already been delivered.
 *
 * The LiveKit SDK is mocked at the module boundary rather than reached: the
 * point is to prove OUR wiring passes the right values, not to test the
 * vendor's constructors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const constructed: { file: unknown[]; s3: unknown[]; egress: unknown[] } = {
  file: [],
  s3: [],
  egress: [],
};

const startRoomCompositeEgress = vi.fn(async () => ({ egressId: 'EG_test_1234' }));
const stopEgress = vi.fn(async () => undefined);

vi.mock('livekit-server-sdk', () => ({
  // Recorded rather than asserted inline, so a change in argument SHAPE (not
  // just value) is visible in the failure message.
  EncodedFileOutput: class {
    constructor(options: unknown) {
      constructed.file.push(options);
    }
  },
  S3Upload: class {
    constructor(options: unknown) {
      constructed.s3.push(options);
    }
  },
  // The enum is read lazily by the module under test. A top-level read would
  // throw under exactly this kind of partial mock, which is why the adapter is
  // async in the first place.
  EncodedFileType: { MP3: 'MP3' },
  EgressClient: class {
    constructor(...args: unknown[]) {
      constructed.egress.push(args);
    }
    startRoomCompositeEgress = startRoomCompositeEgress;
    stopEgress = stopEgress;
  },
}));

const ENV_KEYS = [
  'RECORDING_EGRESS_S3_ENDPOINT',
  'RECORDING_EGRESS_S3_ACCESS_KEY_ID',
  'RECORDING_EGRESS_S3_SECRET_ACCESS_KEY',
  'RECORDINGS_BUCKET',
] as const;

/**
 * The three credentials the predicate actually tests. `RECORDINGS_BUCKET` is
 * deliberately NOT among them: `env.recordingsBucket` carries a default, so a
 * bucket clause could never be false. Writing this test first is what found
 * that — the fourth clause was there, and it was dead.
 */
const REQUIRED_KEYS = [
  'RECORDING_EGRESS_S3_ENDPOINT',
  'RECORDING_EGRESS_S3_ACCESS_KEY_ID',
  'RECORDING_EGRESS_S3_SECRET_ACCESS_KEY',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  constructed.file.length = 0;
  constructed.s3.length = 0;
  constructed.egress.length = 0;
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
});

/** Re-import after an env change — `env` is a module-level snapshot. */
async function load(): Promise<typeof import('../integrations/livekit-phone-dial/egress-output.js')> {
  return import('../integrations/livekit-phone-dial/egress-output.js');
}

describe('phoneEgressConfigured — the pre-flight that keeps a failure OFF the call', () => {
  it('is false when no egress destination is provisioned', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const mod = await load();
    expect(mod.phoneEgressConfigured()).toBe(false);
  });

  for (const missing of REQUIRED_KEYS) {
    it(`is false when ${missing} alone is missing`, async () => {
      // Each of the three is independently load-bearing. A conjunction that
      // dropped one would still pass a test that only ever removes all three.
      process.env.RECORDING_EGRESS_S3_ENDPOINT = 'https://s3.example';
      process.env.RECORDING_EGRESS_S3_ACCESS_KEY_ID = 'key';
      process.env.RECORDING_EGRESS_S3_SECRET_ACCESS_KEY = 'secret';
      process.env.RECORDINGS_BUCKET = 'recordings_v2';
      delete process.env[missing];
      const mod = await load();
      expect(mod.phoneEgressConfigured()).toBe(false);
    });
  }

  it('is true when the three credentials are present', async () => {
    process.env.RECORDING_EGRESS_S3_ENDPOINT = 'https://s3.example';
    process.env.RECORDING_EGRESS_S3_ACCESS_KEY_ID = 'key';
    process.env.RECORDING_EGRESS_S3_SECRET_ACCESS_KEY = 'secret';
    process.env.RECORDINGS_BUCKET = 'recordings_v2';
    const mod = await load();
    expect(mod.phoneEgressConfigured()).toBe(true);
  });

  it('is STILL true without RECORDINGS_BUCKET, because that value has a default', async () => {
    // Pinned so the dead fourth clause cannot quietly come back: if someone
    // re-adds a bucket conjunct, this goes red and says why.
    process.env.RECORDING_EGRESS_S3_ENDPOINT = 'https://s3.example';
    process.env.RECORDING_EGRESS_S3_ACCESS_KEY_ID = 'key';
    process.env.RECORDING_EGRESS_S3_SECRET_ACCESS_KEY = 'secret';
    delete process.env.RECORDINGS_BUCKET;
    const mod = await load();
    expect(mod.phoneEgressConfigured()).toBe(true);
  });
});

describe('createPhoneEgressOutput — the descriptor the recording is written through', () => {
  beforeEach(() => {
    process.env.RECORDING_EGRESS_S3_ENDPOINT = 'https://s3.example';
    process.env.RECORDING_EGRESS_S3_ACCESS_KEY_ID = 'key';
    process.env.RECORDING_EGRESS_S3_SECRET_ACCESS_KEY = 'secret';
    process.env.RECORDINGS_BUCKET = 'recordings_v2';
  });

  it('writes to the EXACT key it is given, as MP3, with the manifest ENABLED', async () => {
    const mod = await load();
    await mod.createPhoneEgressOutput('phone-abc-egress.mp3');

    expect(constructed.file).toHaveLength(1);
    const options = constructed.file[0] as Record<string, unknown>;
    expect(options.filepath).toBe('phone-abc-egress.mp3');
    expect(options.fileType).toBe('MP3');
    // The manifest is WANTED. 0043 stores its key alongside the recording's
    // precisely so a purge deletes both; disabling it would make that column
    // dead weight and leave the purge describing an object that never existed.
    expect(options.disableManifest).toBe(false);
  });

  it('does not rewrite, prefix or sanitize the key it is handed', async () => {
    // The key is DERIVED from the attempt id and 0043 constrains it to exactly
    // that form. A prefix added here would make the stored key and the written
    // object disagree — and the purge deletes the STORED one.
    const mod = await load();
    await mod.createPhoneEgressOutput('phone-zzz-egress.mp3');
    expect((constructed.file[0] as Record<string, unknown>).filepath)
      .toBe('phone-zzz-egress.mp3');
  });

  it('targets the same bucket and path style as the browser recording path', async () => {
    const mod = await load();
    await mod.createPhoneEgressOutput('phone-abc-egress.mp3');

    expect(constructed.s3).toHaveLength(1);
    const s3 = constructed.s3[0] as Record<string, unknown>;
    expect(s3.bucket).toBe('recordings_v2');
    expect(s3.forcePathStyle).toBe(true);
    expect(s3.endpoint).toBe('https://s3.example');
  });
});

describe('createPhoneEgressClient — the two methods, and only those two', () => {
  it('constructs against the configured LiveKit host and exposes start and stop', async () => {
    const mod = await load();
    const client = await mod.createPhoneEgressClient();

    expect(constructed.egress).toHaveLength(1);
    expect(typeof client.startRoomCompositeEgress).toBe('function');
    expect(typeof client.stopEgress).toBe('function');
  });

  it('passes a room, an output and audio-only through to the SDK unchanged', async () => {
    const mod = await load();
    const client = await mod.createPhoneEgressClient();
    const output = { marker: 'output' };
    const info = await client.startRoomCompositeEgress('phone-room', output, {
      audioOnly: true,
      videoOnly: false,
    });

    expect(startRoomCompositeEgress).toHaveBeenCalledWith('phone-room', output, {
      audioOnly: true,
      videoOnly: false,
    });
    expect(info.egressId).toBe('EG_test_1234');
  });
});
