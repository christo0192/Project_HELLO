/**
 * Shared harness for the R1 recording route/finalize/handler suites: an Express app around the REAL
 * router and gate, with an in-memory database, the in-memory object store (`MemoryR1ObjectStore`),
 * a controllable clock and recorded audit / enqueue calls. Nothing here talks to a network.
 */
import express from 'express';
import request from 'supertest';
import { MemoryR1ObjectStore, parseMemoryUrl } from '../../lib/r1/recording/memory-store.js';
import { getR1RecordingConfig, type R1RecordingConfig } from '../../lib/r1/recording/config.js';
import { createSessionLimiter, type SessionLimiter } from '../../lib/r1/recording/gate.js';
import { createR1RecordingInternalRouter } from '../../routes/r1-recording.js';
import {
  ROOM_NAME,
  ROOM_ROUND,
  ROOM_SESSION,
  createRecordingFakeDb,
  liveRecordingTables,
  type FakeRecordingDb,
  type Tables,
} from './r1-recording-fake-db.js';

export const FAKE_S3_ENV = {
  R1_RECORDING_S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  R1_RECORDING_S3_REGION: 'auto',
  R1_RECORDING_S3_BUCKET: 'ik-r1-recordings',
  R1_RECORDING_S3_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
  R1_RECORDING_S3_SECRET_ACCESS_KEY: 'fake-secret-0123456789abcdefghijklmnopqrstuvwxyz',
} as const;

export type EnabledConfig = Extract<R1RecordingConfig, { enabled: true }>;

export function enabledRecordingConfig(extra: Record<string, string> = {}): EnabledConfig {
  const config = getR1RecordingConfig({ ...FAKE_S3_ENV, ...extra });
  if (!config.enabled) throw new Error('fixture config must be enabled');
  return config;
}

export const START_MS = Date.parse('2026-10-12T10:00:00.000Z');

export interface HarnessOptions {
  tables?: Tables;
  config?: R1RecordingConfig;
  r1Enabled?: boolean;
  limiter?: SessionLimiter;
  /** Use the real worker bearer check (WORKER_CONTEXT_SECRET) instead of a pass-through. */
  realAuth?: boolean;
  /** Make the audit sink throw (the fail-closed event). */
  auditFails?: () => boolean;
  store?: MemoryR1ObjectStore;
}

export interface Harness {
  app: express.Express;
  db: FakeRecordingDb;
  store: MemoryR1ObjectStore;
  audits: Array<Record<string, unknown>>;
  enqueued: Array<{ name: string; payload: any; options: { dedupKey: string; maxAttempts: number } }>;
  setNow(ms: number): void;
  advance(ms: number): void;
  nowMs(): number;
  config(): R1RecordingConfig;
  setConfig(config: R1RecordingConfig): void;
  setR1Enabled(on: boolean): void;
  /** POST a worker route with a valid bearer (or none when `bearer` is false). */
  post(route: string, body?: Record<string, unknown>, options?: { bearer?: string | false }): request.Test;
  row(): Record<string, any> | undefined;
}

export const WORKER_SECRET = 'w'.repeat(32);

export function makeHarness(options: HarnessOptions = {}): Harness {
  const tables = options.tables ?? liveRecordingTables();
  const db = createRecordingFakeDb(tables);
  let clock = START_MS;
  const store = options.store ?? new MemoryR1ObjectStore({ now: () => clock });
  const audits: Harness['audits'] = [];
  const enqueued: Harness['enqueued'] = [];
  let config: R1RecordingConfig = options.config ?? enabledRecordingConfig();
  let r1On = options.r1Enabled ?? true;

  const router = createR1RecordingInternalRouter({
    db: db.client as never,
    store: () => store,
    r1Enabled: () => r1On,
    recordingConfig: () => config,
    enqueue: async (name, payload, enqueueOptions) => {
      enqueued.push({ name, payload, options: enqueueOptions });
    },
    now: () => new Date(clock),
    limiter: options.limiter ?? createSessionLimiter({ capacity: 10_000, refillPerSec: 10_000, now: () => clock }),
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    ...(options.realAuth ? {} : { auth: (_req, _res, next) => next() }),
    audit: async (_req, metadata) => {
      if (options.auditFails?.()) throw new Error('Audit sink failure - mutation aborted (fail-closed)');
      audits.push(metadata);
    },
  });
  const app = express();
  app.use('/api/internal/r1/recording', express.json({ limit: '64kb' }), router);

  const harness: Harness = {
    app,
    db,
    store,
    audits,
    enqueued,
    setNow: (ms) => { clock = ms; },
    advance: (ms) => { clock += ms; },
    nowMs: () => clock,
    config: () => config,
    setConfig: (next) => { config = next; },
    setR1Enabled: (on) => { r1On = on; },
    post(route, body = {}, postOptions = {}) {
      let call = request(app).post(`/api/internal/r1/recording/${route}`);
      const bearer = postOptions.bearer === undefined ? WORKER_SECRET : postOptions.bearer;
      if (bearer !== false) call = call.set('authorization', `Bearer ${bearer}`);
      return call.send({ room: ROOM_NAME, ...body });
    },
    row: () => db.tables.interview_round_recordings?.find((r) => r.session_id === ROOM_SESSION),
  };
  return harness;
}

/** Run prepare -> returns the harness's row once `uploading`. */
export async function prepared(harness: Harness, mode: 'audio' | 'av' = 'av'): Promise<Record<string, any>> {
  const response = await harness.post('prepare', { mode });
  if (response.status !== 200) throw new Error(`prepare failed in a fixture: ${response.status} ${JSON.stringify(response.body)}`);
  return harness.row()!;
}

/** Play the WORKER: PUT bytes to a presigned URL the API returned. */
export async function putTo(store: MemoryR1ObjectStore, url: string, body: Uint8Array | string, headers: Record<string, string> = { 'content-type': 'application/octet-stream' }): Promise<Response> {
  return store.httpFetch(url, { method: 'PUT', headers, body });
}

export { parseMemoryUrl, ROOM_NAME, ROOM_ROUND, ROOM_SESSION, liveRecordingTables };
