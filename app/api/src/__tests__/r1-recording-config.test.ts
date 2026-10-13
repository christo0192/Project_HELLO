import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  CHECKPOINT_INTERVAL_SEC,
  MAX_PARTS,
  MAX_URLS,
  PART_SIZE,
  WORKER_URL_TTL_SEC,
  getR1RecordingConfig,
  isValidR2Endpoint,
  resetR1RecordingConfigReport,
  type R1RecordingConfig,
  type R1RecordingEnvSource,
} from '../lib/r1/recording/config.js';
import { createApp } from '../app.js';

const ACCT = '0123456789abcdef0123456789abcdef';
const ENDPOINT = `https://${ACCT}.r2.cloudflarestorage.com`;
const KEY_ID = 'AKIAFAKEFAKEFAKEFAKE';
const SECRET = 'fake-secret-0123456789abcdefghijklmnopqrstuvwxyz';

const valid = (extra: R1RecordingEnvSource = {}): R1RecordingEnvSource => ({
  R1_RECORDING_S3_ENDPOINT: ENDPOINT,
  R1_RECORDING_S3_REGION: 'auto',
  R1_RECORDING_S3_BUCKET: 'ik-r1-recordings',
  R1_RECORDING_S3_ACCESS_KEY_ID: KEY_ID,
  R1_RECORDING_S3_SECRET_ACCESS_KEY: SECRET,
  ...extra,
});

let logged: string[];
beforeEach(() => {
  resetR1RecordingConfigReport();
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function enabled(config: R1RecordingConfig) {
  if (!config.enabled) throw new Error(`expected enabled, got ${config.status}`);
  return config;
}

describe('R1 recording configuration: statuses', () => {
  it('is disabled when nothing is set (and says nothing)', () => {
    expect(getR1RecordingConfig({})).toEqual({ enabled: false, status: 'disabled' });
    expect(getR1RecordingConfig({ R1_RECORDING_S3_ENDPOINT: '', R1_RECORDING_S3_BUCKET: undefined })).toEqual({
      enabled: false,
      status: 'disabled',
    });
    expect(logged).toEqual([]);
  });

  it('is enabled when all five are valid, with the documented knob defaults', () => {
    const config = enabled(getR1RecordingConfig(valid()));
    expect(config.status).toBe('enabled');
    expect(config.s3.endpoint).toBe(ENDPOINT);
    expect(config.s3.region).toBe('auto');
    expect(config.s3.bucket).toBe('ik-r1-recordings');
    expect(config.s3.accessKeyId).toBe(KEY_ID);
    expect(config.s3.secretAccessKey).toBe(SECRET);
    expect(config.maxBytes).toBe(419_430_400);
    expect(config.downloadTtlSec).toBe(300);
    expect(config.retentionDays).toBe(90);
    expect(logged).toEqual([]);
  });

  it('is invalid (recording off) when only some of the five are set, whichever they are', () => {
    const names = Object.keys(valid()) as Array<keyof R1RecordingEnvSource>;
    for (const name of names) {
      const only = getR1RecordingConfig({ [name]: valid()[name] });
      expect(only, `only ${name}`).toMatchObject({ enabled: false, status: 'invalid' });
      const missing = { ...valid() };
      delete missing[name];
      expect(getR1RecordingConfig(missing), `all but ${name}`).toMatchObject({ enabled: false, status: 'invalid' });
    }
  });

  it('treats the .env.example placeholder in the two credential slots as unset (a copied example file is "disabled", not "half configured")', () => {
    const example = {
      R1_RECORDING_S3_ENDPOINT: '',
      R1_RECORDING_S3_REGION: '',
      R1_RECORDING_S3_BUCKET: '',
      R1_RECORDING_S3_ACCESS_KEY_ID: 'replace_me',
      R1_RECORDING_S3_SECRET_ACCESS_KEY: 'replace_me',
      R1_RECORDING_MAX_BYTES: '',
      R1_RECORDING_DOWNLOAD_TTL_SEC: '',
      R1_RECORDING_RETENTION_DAYS: '',
    };
    expect(getR1RecordingConfig(example)).toEqual({ enabled: false, status: 'disabled' });
    expect(logged).toEqual([]);
    // ...but a placeholder where a real credential belongs is still not a working configuration.
    expect(getR1RecordingConfig(valid({ R1_RECORDING_S3_SECRET_ACCESS_KEY: 'replace_me' }))).toMatchObject({ enabled: false, status: 'invalid' });
    // The placeholder is only special in the two credential slots.
    expect(getR1RecordingConfig(valid({ R1_RECORDING_S3_BUCKET: 'replace_me' }))).toMatchObject({ status: 'invalid' });
    expect(getR1RecordingConfig({ R1_RECORDING_S3_BUCKET: 'replace_me' })).toMatchObject({ status: 'invalid' });
  });

  it('fixes the non-knob constants', () => {
    expect([PART_SIZE, MAX_PARTS, MAX_URLS, WORKER_URL_TTL_SEC, CHECKPOINT_INTERVAL_SEC]).toEqual([5_242_880, 60, 400, 600, 120]);
  });
});

describe('R1 recording configuration: endpoint', () => {
  it('accepts the account host, the eu and fedramp jurisdictions, and one trailing slash', () => {
    for (const ok of [
      ENDPOINT,
      `https://${ACCT}.eu.r2.cloudflarestorage.com`,
      `https://${ACCT}.fedramp.r2.cloudflarestorage.com`,
      `${ENDPOINT}/`,
    ]) {
      expect(isValidR2Endpoint(ok), ok).toBe(true);
    }
    // The stored endpoint is normalised (no trailing slash) so the SDK builds clean URLs.
    expect(enabled(getR1RecordingConfig(valid({ R1_RECORDING_S3_ENDPOINT: `${ENDPOINT}/` }))).s3.endpoint).toBe(ENDPOINT);
  });

  it('rejects everything that is not exactly an R2 account origin', () => {
    for (const bad of [
      `http://${ACCT}.r2.cloudflarestorage.com`, // not https
      `${ENDPOINT}/ik-r1-recordings`, // path
      `${ENDPOINT}//`, // more than one slash
      `${ENDPOINT}?x=1`, // query
      `${ENDPOINT}#frag`, // fragment
      `https://${ACCT}.r2.cloudflarestorage.com:8443`, // port
      `https://${ACCT}.r2.cloudflarestorage.com:443`, // explicit port, even the default one
      `https://user:pass@${ACCT}.r2.cloudflarestorage.com`, // userinfo
      `https://user@${ACCT}.r2.cloudflarestorage.com`,
      `https://${ACCT}.r2.cloudflarestorage.com.evil.example`, // suffix trick
      `https://evil.example/${ACCT}.r2.cloudflarestorage.com`,
      `https://${ACCT}.R2.cloudflarestorage.com`, // not lower case
      `https://${ACCT.slice(1)}.r2.cloudflarestorage.com`, // 31 hex
      `https://${ACCT}0.r2.cloudflarestorage.com`, // 33 hex
      `https://${'g'.repeat(32)}.r2.cloudflarestorage.com`, // not hex
      `https://${ACCT}.us.r2.cloudflarestorage.com`, // unknown jurisdiction label
      `https://${ACCT}.eu.fedramp.r2.cloudflarestorage.com`,
      'https://s3.amazonaws.com',
      `https://${ACCT}.r2.dev`,
      `ftp://${ACCT}.r2.cloudflarestorage.com`,
      ` ${ENDPOINT}`,
      `${ENDPOINT} `,
      'not a url',
      '',
    ]) {
      expect(isValidR2Endpoint(bad), JSON.stringify(bad)).toBe(false);
      if (bad !== '') {
        expect(getR1RecordingConfig(valid({ R1_RECORDING_S3_ENDPOINT: bad })), JSON.stringify(bad)).toMatchObject({
          enabled: false,
          status: 'invalid',
        });
      }
    }
  });
});

describe('R1 recording configuration: region, bucket, credentials', () => {
  it('accepts only region "auto"', () => {
    for (const bad of ['us-east-1', 'AUTO', 'auto ', 'wnam']) {
      expect(getR1RecordingConfig(valid({ R1_RECORDING_S3_REGION: bad })), bad).toMatchObject({ status: 'invalid' });
    }
  });

  it('validates the bucket name as an S3 bucket name', () => {
    for (const ok of ['ik-r1-recordings', 'abc', 'a1b', 'a'.repeat(63)]) {
      expect(getR1RecordingConfig(valid({ R1_RECORDING_S3_BUCKET: ok })), ok).toMatchObject({ status: 'enabled' });
    }
    for (const bad of ['ab', 'a'.repeat(64), 'Upper-Case', 'under_score', '-leading', 'trailing-', 'has space', 'dot.ted', 'a/b']) {
      expect(getR1RecordingConfig(valid({ R1_RECORDING_S3_BUCKET: bad })), bad).toMatchObject({ status: 'invalid' });
    }
  });

  it('refuses a credential with whitespace or control characters (a pasted newline would only fail later as an opaque signature error)', () => {
    for (const name of ['R1_RECORDING_S3_ACCESS_KEY_ID', 'R1_RECORDING_S3_SECRET_ACCESS_KEY'] as const) {
      for (const bad of [' ', 'abc def', 'abc\n', '\tabc', 'a\u0000b', String.fromCharCode(233), 'x'.repeat(513)]) {
        expect(getR1RecordingConfig(valid({ [name]: bad })), `${name} ${JSON.stringify(bad).slice(0, 12)}`).toMatchObject({ status: 'invalid' });
      }
    }
  });

  it('keeps the credentials out of every enumeration of the config', () => {
    const config = enabled(getR1RecordingConfig(valid()));
    const text = JSON.stringify(config) + JSON.stringify(config.s3) + JSON.stringify({ ...config.s3 }) + Object.keys(config.s3).join(',');
    expect(text).not.toContain(KEY_ID);
    expect(text).not.toContain(SECRET);
    expect(Object.keys(config.s3).sort()).toEqual(['bucket', 'endpoint', 'region']);
    expect(Object.isFrozen(config.s3)).toBe(true);
    // ...but the adapter can still read them by name.
    expect(config.s3.accessKeyId).toBe(KEY_ID);
    expect(config.s3.secretAccessKey).toBe(SECRET);
  });
});

describe('R1 recording configuration: knobs', () => {
  const cases: Array<{
    name: 'R1_RECORDING_MAX_BYTES' | 'R1_RECORDING_DOWNLOAD_TTL_SEC' | 'R1_RECORDING_RETENTION_DAYS';
    field: 'maxBytes' | 'downloadTtlSec' | 'retentionDays';
    ok: Array<[string, number]>;
    bad: string[];
  }> = [
    {
      name: 'R1_RECORDING_MAX_BYTES',
      field: 'maxBytes',
      ok: [['16777216', 16_777_216], ['419430400', 419_430_400], ['1073741824', 1_073_741_824]],
      bad: ['16777215', '1073741825', '0', '-5', '1e9', '10.5', 'abc', ' 20000000', '20000000 ', '0x1000000', '99999999999999999999'],
    },
    {
      name: 'R1_RECORDING_DOWNLOAD_TTL_SEC',
      field: 'downloadTtlSec',
      ok: [['60', 60], ['300', 300], ['900', 900]],
      bad: ['59', '901', '0', '-1', '1.5', 'x', '300s'],
    },
    {
      name: 'R1_RECORDING_RETENTION_DAYS',
      field: 'retentionDays',
      ok: [['1', 1], ['30', 30], ['90', 90]],
      bad: ['0', '91', '-1', '7.5', 'ninety', '365'],
    },
  ];
  for (const c of cases) {
    it(`${c.name}: bounds are inclusive, anything else is invalid (never clamped)`, () => {
      for (const [raw, value] of c.ok) {
        expect(enabled(getR1RecordingConfig(valid({ [c.name]: raw })))[c.field], raw).toBe(value);
      }
      for (const raw of c.bad) {
        expect(getR1RecordingConfig(valid({ [c.name]: raw })), raw).toMatchObject({ enabled: false, status: 'invalid' });
      }
      // Blank means "use the default".
      expect(getR1RecordingConfig(valid({ [c.name]: '' })), 'blank').toMatchObject({ status: 'enabled' });
    });
  }

  it('a malformed knob is invalid even before the S3 secrets exist (a typo must not wait for them)', () => {
    expect(getR1RecordingConfig({ R1_RECORDING_RETENTION_DAYS: '120' })).toMatchObject({ enabled: false, status: 'invalid' });
    // ...while a valid knob alone changes nothing.
    expect(getR1RecordingConfig({ R1_RECORDING_RETENTION_DAYS: '30' })).toEqual({ enabled: false, status: 'disabled' });
  });
});

describe('R1 recording configuration: it never throws and never prints a value', () => {
  it('survives garbage input of any type', () => {
    const garbage = [123, {}, [], true, Symbol.for('x'), () => 1, null] as unknown[];
    for (const value of garbage) {
      for (const name of Object.keys(valid())) {
        expect(() => getR1RecordingConfig(valid({ [name]: value as string }))).not.toThrow();
        expect(getR1RecordingConfig(valid({ [name]: value as string }))).toMatchObject({ enabled: false });
      }
    }
  });

  it('logs ONE line per distinct reason, naming a variable but never a value', () => {
    const secretish = {
      R1_RECORDING_S3_ENDPOINT: `https://${ACCT}.r2.cloudflarestorage.com/leaky-path`,
      R1_RECORDING_S3_BUCKET: 'Not_A_Bucket',
      R1_RECORDING_S3_ACCESS_KEY_ID: 'bad key id',
      R1_RECORDING_S3_SECRET_ACCESS_KEY: 'bad secret\n',
      R1_RECORDING_MAX_BYTES: '5551212',
      R1_RECORDING_DOWNLOAD_TTL_SEC: '31337',
      R1_RECORDING_RETENTION_DAYS: '4242',
    };
    const attempts: R1RecordingEnvSource[] = [
      valid({ R1_RECORDING_S3_ENDPOINT: secretish.R1_RECORDING_S3_ENDPOINT }),
      valid({ R1_RECORDING_S3_BUCKET: secretish.R1_RECORDING_S3_BUCKET }),
      valid({ R1_RECORDING_S3_ACCESS_KEY_ID: secretish.R1_RECORDING_S3_ACCESS_KEY_ID }),
      valid({ R1_RECORDING_S3_SECRET_ACCESS_KEY: secretish.R1_RECORDING_S3_SECRET_ACCESS_KEY }),
      valid({ R1_RECORDING_MAX_BYTES: secretish.R1_RECORDING_MAX_BYTES }),
      valid({ R1_RECORDING_DOWNLOAD_TTL_SEC: secretish.R1_RECORDING_DOWNLOAD_TTL_SEC }),
      valid({ R1_RECORDING_RETENTION_DAYS: secretish.R1_RECORDING_RETENTION_DAYS }),
      { R1_RECORDING_S3_ACCESS_KEY_ID: KEY_ID, R1_RECORDING_S3_SECRET_ACCESS_KEY: SECRET }, // partial
    ];
    for (const attempt of attempts) {
      expect(getR1RecordingConfig(attempt)).toMatchObject({ status: 'invalid' });
    }
    expect(logged).toHaveLength(attempts.length);
    const everything = logged.join('\n');
    for (const value of [...Object.values(secretish), KEY_ID, SECRET, ACCT, 'leaky-path', 'ik-r1-recordings']) {
      expect(everything, JSON.stringify(value)).not.toContain(value.trim());
    }
    for (const line of logged) expect(line).toMatch(/^\[r1-recording-config\] recording off: (R1_RECORDING_|some but not all of the five R1_RECORDING_S3_)/);
    // The same problem again is not logged a second time.
    getR1RecordingConfig(attempts[0]!);
    expect(logged).toHaveLength(attempts.length);
  });

  it('exposes the reason on an invalid result without any value in it', () => {
    const result = getR1RecordingConfig(valid({ R1_RECORDING_S3_BUCKET: 'Not_A_Bucket' }));
    expect(result).toMatchObject({ status: 'invalid', reason: 'R1_RECORDING_S3_BUCKET is not a valid bucket name' });
    expect(JSON.stringify(result)).not.toContain('Not_A_Bucket');
  });
});

describe('R1 recording configuration: reads process.env lazily, literally', () => {
  const names = Object.keys(valid()).concat(['R1_RECORDING_MAX_BYTES', 'R1_RECORDING_DOWNLOAD_TTL_SEC', 'R1_RECORDING_RETENTION_DAYS']);
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const n of names) saved[n] = process.env[n];
  });
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('reads the environment at call time when no source is given', () => {
    for (const n of names) delete process.env[n];
    expect(getR1RecordingConfig()).toEqual({ enabled: false, status: 'disabled' });
    Object.assign(process.env, valid({ R1_RECORDING_RETENTION_DAYS: '45' }));
    expect(enabled(getR1RecordingConfig()).retentionDays).toBe(45);
    process.env.R1_RECORDING_S3_BUCKET = 'Bad_Bucket';
    expect(getR1RecordingConfig()).toMatchObject({ status: 'invalid' });
  });

  it('does not prevent the shared API from booting when the recording variables are malformed', async () => {
    Object.assign(process.env, {
      R1_RECORDING_S3_ENDPOINT: 'http://nope',
      R1_RECORDING_S3_REGION: 'wrong',
      R1_RECORDING_S3_BUCKET: 'X',
      R1_RECORDING_S3_ACCESS_KEY_ID: 'a b',
      R1_RECORDING_S3_SECRET_ACCESS_KEY: '',
      R1_RECORDING_MAX_BYTES: 'many',
      R1_RECORDING_DOWNLOAD_TTL_SEC: '-3',
      R1_RECORDING_RETENTION_DAYS: '9999',
    });
    const app = createApp({ nodeEnv: 'test', auditSinkOverride: async () => undefined });
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});
