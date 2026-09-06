/**
 * Fly Machines API client — unit + negative controls.
 *
 * Fully deterministic: the network is replaced by a scripted transport, sleep
 * is a no-op (no unbounded waiting), and jitter is fixed. Synthetic app slugs
 * and machine ids only. Proves method/URL/auth shape for every verb, retry on
 * 429/5xx/network then success, give-up-with-typed-error after the attempt cap,
 * missing-token fail-closed with NO network call, and the wait query shape. No
 * real network is ever touched.
 */

import { describe, it, expect } from 'vitest';
import {
  FlyMachinesClient,
  createFlyMachinesClient,
  FlyMachinesError,
  isFlyMachinesError,
  FLY_API_BASE_URL,
  type FlyTransport,
  type FlyTransportRequest,
  type FlyTransportResponse,
  type FlyLogRecord,
} from '../lib/fly-machines.js';

// ── Transport scripting ───────────────────────────────────────────────────

type Step = FlyTransportResponse | Error | 'abort';

function res(status: number, body: string, headers: Record<string, string> = {}): FlyTransportResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    text: async () => body,
  };
}

function ok(obj: unknown): FlyTransportResponse {
  return res(200, JSON.stringify(obj));
}

function scripted(steps: Step[]) {
  const calls: FlyTransportRequest[] = [];
  let i = 0;
  const transport: FlyTransport = async (req) => {
    calls.push(req);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === 'abort') {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (step instanceof Error) throw step;
    return step;
  };
  return { transport, calls, count: () => i };
}

function makeClient(steps: Step[], overrides: Record<string, unknown> = {}) {
  const s = scripted(steps);
  const sleepLog: number[] = [];
  const logs: FlyLogRecord[] = [];
  const client = new FlyMachinesClient({
    token: 'synthetic-token',
    transport: s.transport,
    random: () => 0.5,
    sleep: async (ms: number) => { sleepLog.push(ms); },
    logger: { event: (r) => logs.push(r) },
    ...overrides,
  });
  return { client, calls: s.calls, count: s.count, sleepLog, logs };
}

const APP = 'project-hello-phone-voice';
const MID = 'abcdef1234567890';

// ── Construction / base-URL allowlist ──────────────────────────────────────

describe('construction', () => {
  it('constructs with a token and the default allowlisted origin', () => {
    const c = new FlyMachinesClient({ token: 'k' });
    expect(c).toBeInstanceOf(FlyMachinesClient);
    // api.machines.dev is the host that actually serves the Machines REST API
    // (api.fly.io/v1 404s every /apps/{app}/machines call — RCA 2026-09-06).
    expect(FLY_API_BASE_URL).toBe('https://api.machines.dev/v1');
  });

  it('constructs WITHOUT a token (fails closed at call time, not at import)', () => {
    expect(() => new FlyMachinesClient()).not.toThrow();
    expect(() => new FlyMachinesClient({ token: '' })).not.toThrow();
  });

  it('rejects a non-allowlisted base URL without an injected transport', () => {
    let thrown: unknown;
    try { new FlyMachinesClient({ token: 'k', baseUrl: 'https://evil.example.com' }); } catch (e) { thrown = e; }
    expect(isFlyMachinesError(thrown)).toBe(true);
    expect((thrown as FlyMachinesError).code).toBe('invalid_request');
  });

  it('permits a custom base URL only alongside an injected transport (test seam)', () => {
    const { transport } = scripted([ok({ id: MID, state: 'started' })]);
    expect(() => new FlyMachinesClient({ token: 'k', baseUrl: 'http://127.0.0.1:9', transport })).not.toThrow();
  });

  it('createFlyMachinesClient factory works', () => {
    expect(createFlyMachinesClient({ token: 'k' })).toBeInstanceOf(FlyMachinesClient);
  });
});

// ── Auth header ────────────────────────────────────────────────────────────

describe('bearer auth', () => {
  it('sends Authorization: Bearer <token> and never puts the token in the URL', async () => {
    const { client, calls } = makeClient([ok({ id: MID, state: 'started' })]);
    await client.getMachine(APP, MID);
    const req = calls[0];
    expect(req.headers.authorization).toBe('Bearer synthetic-token');
    expect(req.url).not.toContain('synthetic-token');
    expect(req.headers.accept).toBe('application/json');
  });
});

// ── Method + URL shape per verb ─────────────────────────────────────────────

describe('request shape', () => {
  it('listMachines → GET /apps/{app}/machines and maps typed machines', async () => {
    const { client, calls } = makeClient([ok([
      { id: 'm1', state: 'stopped', region: 'sin' },
      { id: 'm2', state: 'started' },
    ])]);
    const list = await client.listMachines(APP);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${FLY_API_BASE_URL}/apps/${APP}/machines`);
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(list[0].state).toBe('stopped');
    expect(list[0].raw).toMatchObject({ id: 'm1', region: 'sin' });
  });

  it('getMachine → GET /apps/{app}/machines/{id}', async () => {
    const { client, calls } = makeClient([ok({ id: MID, state: 'started', name: 'w' })]);
    const m = await client.getMachine(APP, MID);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${FLY_API_BASE_URL}/apps/${APP}/machines/${MID}`);
    expect(m.id).toBe(MID);
    expect(m.state).toBe('started');
  });

  it('startMachine → POST /apps/{app}/machines/{id}/start', async () => {
    const { client, calls } = makeClient([ok({ ok: true })]);
    await client.startMachine(APP, MID);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${FLY_API_BASE_URL}/apps/${APP}/machines/${MID}/start`);
  });

  it('stopMachine → POST /apps/{app}/machines/{id}/stop', async () => {
    const { client, calls } = makeClient([ok({ ok: true })]);
    await client.stopMachine(APP, MID);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${FLY_API_BASE_URL}/apps/${APP}/machines/${MID}/stop`);
  });

  it('waitForState → GET …/wait?state=<state>&timeout=<sec> with both query params', async () => {
    const { client, calls } = makeClient([ok({ id: MID, state: 'started' })]);
    await client.waitForState(APP, MID, 'started', 45);
    expect(calls[0].method).toBe('GET');
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/v1/apps/${APP}/machines/${MID}/wait`);
    expect(url.searchParams.get('state')).toBe('started');
    expect(url.searchParams.get('timeout')).toBe('45');
  });

  it('waitForState clamps an over-large timeout to 60 and rejects an unknown state', async () => {
    const { client, calls } = makeClient([ok({ id: MID, state: 'stopped' })]);
    await client.waitForState(APP, MID, 'stopped', 9999);
    expect(new URL(calls[0].url).searchParams.get('timeout')).toBe('60');
    await expect(client.waitForState(APP, MID, 'running' as never, 30)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

// ── Input validation ─────────────────────────────────────────────────────────

describe('input validation (fail closed, no network)', () => {
  it('rejects an empty app slug and a path-structural id without any transport call', async () => {
    const { client, count } = makeClient([ok({ id: MID, state: 'started' })]);
    await expect(client.getMachine('', MID)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.getMachine(APP, '../other')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.getMachine(APP, 'a/b')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(count()).toBe(0);
  });
});

// ── Retry behavior ─────────────────────────────────────────────────────────

describe('retries on transient classes then succeed', () => {
  it('retries a 429 (honoring Retry-After) then a 500 then succeeds', async () => {
    const { client, count, sleepLog, logs } = makeClient(
      [res(429, '{}', { 'retry-after': '2' }), res(500, '{}'), ok({ id: MID, state: 'started' })],
      { maxAttempts: 4 },
    );
    const m = await client.getMachine(APP, MID);
    expect(m.id).toBe(MID);
    expect(count()).toBe(3);
    expect(sleepLog[0]).toBe(2000); // Retry-After: 2s honored
    expect(sleepLog.length).toBe(2);
    expect(logs.filter((l) => l.outcome === 'retry').length).toBe(2);
    expect(logs.at(-1)?.outcome).toBe('success');
  });

  it('retries a network failure then succeeds (idempotent GET)', async () => {
    const { client, count } = makeClient(
      [new Error('ECONNRESET'), ok({ id: MID, state: 'started' })],
      { maxAttempts: 3 },
    );
    const m = await client.getMachine(APP, MID);
    expect(m.state).toBe('started');
    expect(count()).toBe(2);
  });

  it('retries an aborted (timeout) start then succeeds — start is idempotent', async () => {
    const { client, count } = makeClient(['abort', ok({ ok: true })], { maxAttempts: 3 });
    await client.startMachine(APP, MID);
    expect(count()).toBe(2);
  });
});

// ── Give up with a typed error ───────────────────────────────────────────────

describe('gives up after the attempt cap', () => {
  it('exhausts attempts on repeated 500 and throws retry_exhausted (bounded, not forever)', async () => {
    const { client, count } = makeClient([res(500, '{}')], { maxAttempts: 3 });
    const err = await client.stopMachine(APP, MID).catch((e) => e);
    expect(isFlyMachinesError(err)).toBe(true);
    expect(err.code).toBe('retry_exhausted');
    expect(err.httpStatus).toBe(500);
    expect(count()).toBe(3); // exactly the cap — never unbounded
  });

  it('exhausts attempts on repeated network failure and throws retry_exhausted', async () => {
    const { client, count } = makeClient([new Error('ENETUNREACH')], { maxAttempts: 2 });
    const err = await client.listMachines(APP).catch((e) => e);
    expect(err.code).toBe('retry_exhausted');
    expect(count()).toBe(2);
  });
});

// ── Permanent (non-retriable) classes ────────────────────────────────────────

describe('permanent classes are not retried', () => {
  it('maps 401/403 → auth and does not retry', async () => {
    const { client, count } = makeClient([res(403, '{}')], { maxAttempts: 4 });
    const err = await client.getMachine(APP, MID).catch((e) => e);
    expect(err.code).toBe('auth');
    expect(count()).toBe(1);
  });

  it('maps 404 → not_found and does not retry', async () => {
    const { client, count } = makeClient([res(404, '{}')], { maxAttempts: 4 });
    const err = await client.getMachine(APP, MID).catch((e) => e);
    expect(err.code).toBe('not_found');
    expect(count()).toBe(1);
  });
});

// ── Missing token → fail closed with NO network call ─────────────────────────

describe('missing token fails closed', () => {
  it('every verb throws code auth with zero transport calls when no token is set', async () => {
    const s = scripted([ok({ id: MID, state: 'started' })]);
    const client = new FlyMachinesClient({ transport: s.transport, baseUrl: 'http://127.0.0.1:9' });
    for (const call of [
      () => client.listMachines(APP),
      () => client.getMachine(APP, MID),
      () => client.startMachine(APP, MID),
      () => client.stopMachine(APP, MID),
      () => client.waitForState(APP, MID, 'started', 30),
    ]) {
      const err = await call().catch((e) => e);
      expect(isFlyMachinesError(err)).toBe(true);
      expect(err.code).toBe('auth');
    }
    expect(s.count()).toBe(0); // never touched the network
  });

  it('treats the replace_me placeholder as absent (fail closed)', async () => {
    const s = scripted([ok({ id: MID, state: 'started' })]);
    const client = new FlyMachinesClient({ token: 'replace_me', transport: s.transport, baseUrl: 'http://x' });
    await expect(client.getMachine(APP, MID)).rejects.toMatchObject({ code: 'auth' });
    expect(s.count()).toBe(0);
  });
});

// ── Error sanitization ───────────────────────────────────────────────────────

describe('error sanitization', () => {
  it('never serializes the provider body — toJSON carries only sanitized fields', async () => {
    const secretBody = JSON.stringify({ error: 'token abcSECRET leaked', trace: 'sensitive' });
    const { client } = makeClient([res(500, secretBody)], { maxAttempts: 1 });
    const err = await client.getMachine(APP, MID).catch((e) => e) as FlyMachinesError;
    const serialized = JSON.stringify(err.toJSON());
    expect(serialized).not.toContain('abcSECRET');
    expect(serialized).not.toContain('sensitive');
    expect(err.toJSON()).toMatchObject({ name: 'FlyMachinesError', operation: 'getMachine' });
  });
});
