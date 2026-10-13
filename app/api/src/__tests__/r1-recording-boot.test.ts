import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// If anything on the boot path imports the AWS SDK, these factories throw and the test fails. The
// API also runs phone dialing: a broken or missing SDK must never be able to stop it from booting.
const sdkTouched = vi.hoisted(() => ({ imports: [] as string[] }));
vi.mock('@aws-sdk/client-s3', () => {
  sdkTouched.imports.push('@aws-sdk/client-s3');
  throw new Error('the AWS SDK must not be imported at boot');
});
vi.mock('@aws-sdk/s3-request-presigner', () => {
  sdkTouched.imports.push('@aws-sdk/s3-request-presigner');
  throw new Error('the AWS SDK must not be imported at boot');
});

import { createApp } from '../app.js';
import { getR1RecordingConfig } from '../lib/r1/recording/config.js';

describe('the recording storage layer cannot affect API boot', () => {
  it('boots without loading the S3 SDK, with the recording variables unset or malformed', async () => {
    const names = ['R1_RECORDING_S3_ENDPOINT', 'R1_RECORDING_S3_REGION', 'R1_RECORDING_S3_BUCKET', 'R1_RECORDING_S3_ACCESS_KEY_ID', 'R1_RECORDING_S3_SECRET_ACCESS_KEY'] as const;
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const n of names) delete process.env[n];
      const plain = createApp({ nodeEnv: 'test', auditSinkOverride: async () => undefined });
      expect((await request(plain).get('/api/health')).status).toBe(200);

      process.env.R1_RECORDING_S3_ENDPOINT = 'http://not-r2';
      process.env.R1_RECORDING_S3_REGION = 'nowhere';
      const malformed = createApp({ nodeEnv: 'test', auditSinkOverride: async () => undefined });
      expect((await request(malformed).get('/api/health')).status).toBe(200);
      expect(getR1RecordingConfig()).toMatchObject({ enabled: false, status: 'invalid' });
    } finally {
      spy.mockRestore();
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
    expect(sdkTouched.imports).toEqual([]);
  });

  it('importing the adapter and building a store does not load the SDK; using it with a broken SDK fails soft', async () => {
    const { createS3Store } = await import('../lib/r1/recording/s3-store.js');
    const config = getR1RecordingConfig({
      R1_RECORDING_S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      R1_RECORDING_S3_REGION: 'auto',
      R1_RECORDING_S3_BUCKET: 'ik-r1-recordings',
      R1_RECORDING_S3_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
      R1_RECORDING_S3_SECRET_ACCESS_KEY: 'fake-secret-0123456789abcdefghijklmnopqrstuvwxyz',
    });
    if (!config.enabled) throw new Error('fixture config must be enabled');
    const store = createS3Store(config.s3);
    expect(sdkTouched.imports).toEqual([]);
    // The first real use triggers the import, which fails here: the store reports a transient
    // failure (the caller defers) instead of throwing a raw module error.
    await expect(store.head('r1/x')).rejects.toMatchObject({ name: 'R1StoreError', code: 'unavailable' });
    expect(sdkTouched.imports.length).toBeGreaterThan(0);
  });
});
