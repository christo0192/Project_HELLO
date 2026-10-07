/**
 * PR-L isolation: retiring the legacy browser lane must not touch R1 or phone.
 *
 * Two kinds of evidence:
 *  1. Behavioural. The REAL app is booted with LEGACY_BROWSER_SCREENING_ENABLED
 *     =false: the legacy entry points answer 410, `/api/me` reports the lane
 *     retired, while the R1 routes (recruiter + worker-internal) and the phone
 *     routes stay mounted and answer exactly as they do with the lane enabled.
 *  2. Structural. Only the documented call sites reference the retirement
 *     switch, and no phone or R1 source (nor fly.phone.toml) mentions it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  RESUME_BUCKET: 'resumes_v2',
}));

import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';

process.env.RATE_LIMIT_DEFAULT = '100000';
process.env.RATE_LIMIT_IP = '100000';

const FLAG = 'LEGACY_BROWSER_SCREENING_ENABLED';
const ORIGINAL_FLAG = process.env[FLAG];
const ORIGINAL_SECRET = process.env.WORKER_CONTEXT_SECRET;
const WORKER_SECRET = 'r1-isolation-worker-secret-0123456789abcdef';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = `Bearer ${JWT}`;
const CANDIDATE = '10000000-0000-4000-8000-000000000001';
const ADMIN: AuthUser = {
  id: 'user-admin-0000-0000-000000000001',
  email: 'admin@example.com',
  aal: 'aal2',
  active: true,
  appRole: 'admin',
  orgId: null,
};

/** A permissive Supabase double: every chain ends in one canned result. */
function chain(table: string): unknown {
  const row = table === 'candidates'
    ? { id: CANDIDATE, owner_id: ADMIN.id, status: 'new', decision_use_blocked_at: null }
    : { singleton: true, enabled: false, paused: false, livekit_target: 'cloud' };
  const terminal = { data: table === 'interview_rounds' ? [] : row, error: null };
  const q: Record<string, unknown> = {};
  const self = new Proxy(q, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
      }
      if (prop === 'single' || prop === 'maybeSingle') return async () => terminal;
      return () => self;
    },
  });
  return self;
}

function bootApp(authed = true) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    ...(authed ? { authDeps: { getUser: mockAuthGetUser(ADMIN, JWT) } } : {}),
    auditSinkOverride: async () => undefined,
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  setRateLimitStore(new MemoryRateLimitStore());
  mocks.from.mockImplementation((table: string) => chain(table));
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
  else process.env[FLAG] = ORIGINAL_FLAG;
  if (ORIGINAL_SECRET === undefined) delete process.env.WORKER_CONTEXT_SECRET;
  else process.env.WORKER_CONTEXT_SECRET = ORIGINAL_SECRET;
  warnSpy.mockRestore();
});

describe('the real app with the legacy lane retired', () => {
  beforeEach(() => {
    process.env[FLAG] = 'false';
  });

  it('boots, and the legacy entry points answer 410 through the full stack', async () => {
    const app = bootApp();
    expect((await request(app).get('/api/health')).status).toBe(200);

    const start = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH)
      .send({ candidate_id: CANDIDATE });
    expect(start.status).toBe(410);
    expect(start.body.error).toBe('browser_screening_retired');

    // /exchange and /preflight are candidate-facing (public): 410 for anyone.
    const exchange = await request(app)
      .post('/api/livekit/exchange')
      .send({ token: 'a'.repeat(64) });
    expect(exchange.status).toBe(410);
    const preflight = await request(app)
      .post('/api/livekit/preflight')
      .send({ invite_token: 'a'.repeat(64) });
    expect(preflight.status).toBe(410);
  });

  it('retires the join page consent routes too, but not the invite-free template', async () => {
    const app = bootApp(false);
    const status = await request(app)
      .post('/api/candidate-consent/status')
      .send({ invite_token: 'a'.repeat(64) });
    expect(status.status).toBe(410);
    expect(status.body).toEqual({ error: 'browser_screening_retired' });
    const submit = await request(app).post('/api/candidate-consent/submit').send({});
    expect(submit.status).toBe(410);
    expect(submit.body).toEqual({ error: 'browser_screening_retired' });
    const template = await request(app).get('/api/candidate-consent/template');
    expect(template.status).not.toBe(410);
  });

  it('keeps authentication first: an unauthenticated start is 401, not 410', async () => {
    const res = await request(bootApp(false)).post('/api/livekit/start').send({});
    expect(res.status).toBe(401);
  });

  it('reports the lane as retired on /api/me so the web can hide the card', async () => {
    const res = await request(bootApp()).get('/api/me').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.legacyBrowserScreeningEnabled).toBe(false);
    expect(res.body.role).toBe('admin');
  });

  it('leaves the R1 recruiter routes untouched', async () => {
    const app = bootApp();
    const settings = await request(app).get('/api/admin/r1/settings').set('Authorization', AUTH);
    expect(settings.status).toBe(200);
    expect(settings.body.runtime).toBeDefined();
    const rounds = await request(app)
      .get(`/api/candidates/${CANDIDATE}/interview-rounds`)
      .set('Authorization', AUTH);
    expect(rounds.status).toBe(200);
    expect(rounds.body).toEqual({ rounds: [] });
  });

  it('leaves the R1 worker-internal routes untouched', async () => {
    const app = bootApp(false);
    const noBearer = await request(app).post('/api/internal/r1/context').send({ room: 'x' });
    expect(noBearer.status).toBe(401);
    const badRoom = await request(app)
      .post('/api/internal/r1/context')
      .set('Authorization', `Bearer ${WORKER_SECRET}`)
      .send({ room: 'not-an-r1-room' });
    expect(badRoom.status).toBe(400);
    expect(badRoom.body).toEqual({ error: 'invalid_r1_room' });
  });

  it('leaves the phone routes mounted and unchanged', async () => {
    const app = bootApp(false);
    const phone = await request(app).get('/api/phone/health');
    expect(phone.status).toBe(401);
    const webhook = await request(app).post('/api/integrations/livekit-phone/webhook').send({});
    expect(webhook.status).not.toBe(410);
    const plivo = await request(app).post('/api/integrations/plivo/answer').send({});
    expect(plivo.status).not.toBe(410);
  });
});

describe('the real app with the legacy lane enabled (default)', () => {
  it('reports the lane as enabled on /api/me and does not 410', async () => {
    delete process.env[FLAG];
    const app = bootApp();
    const me = await request(app).get('/api/me').set('Authorization', AUTH);
    expect(me.body.legacyBrowserScreeningEnabled).toBe(true);
    const start = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH)
      .send({});
    expect(start.status).toBe(400);
  });

  it('does not 410 the consent routes (they validate and answer as before)', async () => {
    delete process.env[FLAG];
    const app = bootApp(false);
    const status = await request(app)
      .post('/api/candidate-consent/status')
      .send({ invite_token: 'a'.repeat(64) });
    expect(status.status).not.toBe(410);
    const submit = await request(app).post('/api/candidate-consent/submit').send({});
    expect(submit.status).toBe(400);
  });
});

describe('isolation of the retirement switch', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = join(here, '..');
  const repoRoot = join(here, '..', '..', '..', '..');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        out.push(...sourceFiles(full));
      } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  const files = sourceFiles(srcRoot).map((f) => ({
    path: relative(srcRoot, f).split(sep).join('/'),
    text: readFileSync(f, 'utf8'),
  }));
  // Phone and R1 owned source: routes, libs and the phone integrations.
  const LANE_OWNED = new RegExp(
    '^(routes/(phone|plivo|r1)|lib/(phone|r1/)|integrations/(livekit-phone|plivo))',
  );
  const referencing = (needle: RegExp) =>
    files.filter((f) => needle.test(f.text)).map((f) => f.path).sort();

  it('is read by exactly the documented call sites and nothing else', () => {
    expect(referencing(/legacy-browser-screening/)).toEqual([
      'integrations/ashby/operation-worker.ts',
      'integrations/ashby/runtime-workers.ts',
      'lib/legacy-browser-screening.ts',
      'routes/ashby-mission-control.ts',
      'routes/candidate-consent.ts',
      'routes/invites.ts',
      'routes/livekit.ts',
      'routes/me.ts',
    ]);
    // The variable itself is READ in one place only (comments elsewhere may name it).
    expect(referencing(/process\.env\.LEGACY_BROWSER_SCREENING_ENABLED/)).toEqual([
      'lib/legacy-browser-screening.ts',
    ]);
  });

  it('is never referenced by phone or R1 source', () => {
    const laneOwned = files.filter((f) => LANE_OWNED.test(f.path));
    expect(laneOwned.length).toBeGreaterThan(10);
    for (const file of laneOwned) {
      expect(file.text, file.path).not.toMatch(/legacy-browser-screening|LEGACY_BROWSER/i);
    }
  });

  it('is not present in the phone Fly config or the voice worker sources', () => {
    const voice = join(repoRoot, 'app', 'voice-livekit');
    const phoneToml = join(voice, 'fly.phone.toml');
    expect(existsSync(phoneToml)).toBe(true);
    expect(readFileSync(phoneToml, 'utf8')).not.toMatch(/LEGACY_BROWSER/);
    for (const name of readdirSync(voice)) {
      if (!name.endsWith('.py') || name.startsWith('test_')) continue;
      expect(readFileSync(join(voice, name), 'utf8'), name).not.toMatch(/LEGACY_BROWSER/);
    }
  });

  it('is set to false only in the API Fly config, which phone does not use', () => {
    const apiToml = readFileSync(join(repoRoot, 'app', 'api', 'fly.toml'), 'utf8');
    expect(apiToml).toMatch(/^\s*LEGACY_BROWSER_SCREENING_ENABLED = "false"\s*$/m);
  });
});
