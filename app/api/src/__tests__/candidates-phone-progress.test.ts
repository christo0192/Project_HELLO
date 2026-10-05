/**
 * Phone progress on the candidate list and detail: dial_count, phone_state,
 * an ALLOWLISTED phone_state_reason, last_dialed_at.
 *
 * Why this exists: `candidates.status` stays `queued` for the whole of a phone
 * cycle, so a candidate dialled five times — or one whose cycle ended
 * `abandoned_no_answer` — read "Queued" with nothing else to go on.
 *
 * The three things this file defends hardest:
 *   1. The dial predicate. infra_deferred abandons never rang (excluded);
 *      lease-reclaimed abandons rang and were charged (counted); a
 *      provider_error was refused before ringing (excluded).
 *   2. Unknown is never zero. A failed, malformed or possibly-truncated read
 *      reports dial_count null, and never fails the route.
 *   3. No new exposure. The reason column is free text, the list is
 *      viewer-level, so the reason crosses only through a closed allowlist.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import {
  isReachedDial,
  reducePhoneProgress,
  loadPhoneProgress,
  projectPhoneStateReason,
  chunkIds,
  PHONE_PROGRESS_CHUNK_SIZE,
  PHONE_PROGRESS_ROW_CAP,
  PHONE_PROGRESS_ENGAGEMENT_STATES,
  PHONE_PROGRESS_REASON_ALLOWLIST,
  PHONE_PROGRESS_SELECT,
  type RawEngagementRow,
} from '../lib/candidate-phone-progress.js';
import { PHONE_ENGAGEMENT_STATES } from '../lib/phone-screening/vocabulary.js';
import { PHONE_OUTCOME_MIGRATION_REASONS } from '../lib/phone-screening/budget.js';

// ─── Supabase mock: per-table results, every builder call recorded ──────

type TableResult = { data: unknown; error: unknown } | Error;
type TableEntry = TableResult | ((ctx: { call: number; inValues: string[] | null }) => TableResult);

const mockFrom = vi.fn();
const fromCalls: string[] = [];
const inCalls: Array<{ table: string; column: string; values: string[] }> = [];
const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
const selects: Array<{ table: string; columns: unknown }> = [];

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
  RESUME_BUCKET: 'resumes_v2',
}));

function chain(table: string, resolveValue: (inValues: string[] | null) => TableResult): Record<string, unknown> {
  let inValues: string[] | null = null;
  const c: Record<string, unknown> = {};
  const methods = ['insert', 'update', 'upsert', 'delete', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'not', 'order', 'limit', 'range', 'single', 'maybeSingle'];
  for (const m of methods) c[m] = () => c;
  c.select = (columns: unknown) => { selects.push({ table, columns }); return c; };
  c.eq = (column: string, v: unknown) => { eqCalls.push({ table, column, value: v }); return c; };
  c.in = (column: string, values: string[]) => {
    inCalls.push({ table, column, values });
    inValues = values;
    return c;
  };
  const settle = (): Promise<unknown> => {
    const v = resolveValue(inValues);
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => settle().then(resolve, reject);
  c.catch = (reject: (e: unknown) => unknown) => settle().catch(reject);
  return c;
}

function configure(config: Record<string, TableEntry>): void {
  const counters: Record<string, number> = {};
  mockFrom.mockImplementation((table: string) => {
    fromCalls.push(table);
    const call = counters[table] ?? 0;
    counters[table] = call + 1;
    const entry = config[table];
    return chain(table, (inValues) => {
      if (entry === undefined) return { data: null, error: null };
      return typeof entry === 'function' ? entry({ call, inValues }) : entry;
    });
  });
}

const ok = (data: unknown) => ({ data, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  fromCalls.length = 0; inCalls.length = 0; eqCalls.length = 0; selects.length = 0;
});

// ─── Fixtures ───────────────────────────────────────────────────────────

const T = (d: number) => `2026-10-0${d}T09:00:00.000Z`;

const attempt = (over: Partial<Record<string, unknown>> = {}) => ({
  state: 'ended', abandon_reason: null, outcome_class: 'no_answer', admitted_at: T(1), ...over,
});

const engagement = (candidate_id: string, over: Partial<RawEngagementRow> = {}): RawEngagementRow => ({
  candidate_id, cycle_number: 1, created_at: T(1), state: 'awaiting_retry', state_reason: null,
  phone_call_attempts: [], ...over,
});

// ═══════════════════════════════════════════════════════════════════════
// 1. The dial predicate
// ═══════════════════════════════════════════════════════════════════════

describe('isReachedDial', () => {
  it('EXCLUDES an infra_deferred abandon: given up before any carrier contact', () => {
    expect(isReachedDial({ state: 'abandoned', abandon_reason: 'infra_deferred', outcome_class: null })).toBe(false);
  });

  it('COUNTS a lease-reclaimed abandon (null abandon_reason): it rang before the worker died', () => {
    expect(isReachedDial({ state: 'abandoned', abandon_reason: null, outcome_class: null })).toBe(true);
    // An undefined column (an older payload) is the same as null.
    expect(isReachedDial({ state: 'abandoned', outcome_class: null })).toBe(true);
  });

  it('EXCLUDES provider_error: the carrier refused the originate before ringing', () => {
    expect(isReachedDial({ state: 'ended', abandon_reason: null, outcome_class: 'provider_error' })).toBe(false);
    expect(isReachedDial({ state: 'abandoned', abandon_reason: null, outcome_class: 'provider_error' })).toBe(false);
  });

  it('COUNTS every other outcome and an in-flight attempt', () => {
    for (const outcome of ['no_answer', 'busy', 'voicemail', 'completed', 'disconnected', 'abandoned_pre_disclosure', null]) {
      expect(isReachedDial({ state: 'ended', abandon_reason: null, outcome_class: outcome })).toBe(true);
    }
    expect(isReachedDial({ state: 'admitted', abandon_reason: null, outcome_class: null })).toBe(true);
    expect(isReachedDial({ state: 'ringing', abandon_reason: null, outcome_class: null })).toBe(true);
  });

  it('infra_deferred only excludes when the attempt is actually abandoned', () => {
    // 0083 stamps the reason only on abandoned rows; the SQL form is
    // `state <> 'abandoned' OR abandon_reason IS DISTINCT FROM 'infra_deferred'`.
    expect(isReachedDial({ state: 'ended', abandon_reason: 'infra_deferred', outcome_class: 'no_answer' })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The reducer
// ═══════════════════════════════════════════════════════════════════════

describe('reducePhoneProgress', () => {
  it('counts reached dials only: infra_deferred and provider_error out, lease-reclaimed in', () => {
    const m = reducePhoneProgress([
      engagement('c1', {
        phone_call_attempts: [
          attempt({ admitted_at: T(1) }),
          attempt({ state: 'abandoned', abandon_reason: 'infra_deferred', outcome_class: null, admitted_at: T(2) }),
          attempt({ state: 'abandoned', abandon_reason: null, outcome_class: null, admitted_at: T(3) }),
          attempt({ outcome_class: 'provider_error', admitted_at: T(4) }),
        ],
      }),
    ]);
    expect(m.get('c1')?.dial_count).toBe(2);
  });

  it('sums dials across every cycle, and takes the state from the HIGHEST cycle', () => {
    const m = reducePhoneProgress([
      engagement('c1', { cycle_number: 3, created_at: T(1), state: 'abandoned_no_answer', state_reason: 'no_answer_budget_exhausted', phone_call_attempts: [attempt(), attempt()] }),
      engagement('c1', { cycle_number: 1, created_at: T(5), state: 'failed', state_reason: 'assessment_aborted', phone_call_attempts: [attempt()] }),
      engagement('c1', { cycle_number: 2, created_at: T(3), state: 'cancelled', phone_call_attempts: [attempt(), attempt()] }),
    ]);
    const p = m.get('c1')!;
    expect(p.dial_count).toBe(5);
    // Cycle 3 wins even though cycle 1 was created later.
    expect(p.phone_state).toBe('abandoned_no_answer');
    expect(p.phone_state_reason).toBe('no_answer_budget_exhausted');
  });

  it('breaks a cycle_number tie by newest created_at', () => {
    const m = reducePhoneProgress([
      engagement('c1', { cycle_number: 1, created_at: T(1), state: 'failed' }),
      engagement('c1', { cycle_number: 1, created_at: T(4), state: 'eligible' }),
    ]);
    expect(m.get('c1')?.phone_state).toBe('eligible');
  });

  it('an engagement with no attempts is dial_count 0, not unknown', () => {
    const m = reducePhoneProgress([engagement('c1', { state: 'pending_prereqs' })]);
    expect(m.get('c1')).toEqual({ dial_count: 0, phone_state: 'pending_prereqs', phone_state_reason: null, last_dialed_at: null });
  });

  it('a candidate with no engagement is ABSENT (the loader reports it as never engaged)', () => {
    expect(reducePhoneProgress([engagement('c1')]).has('c2')).toBe(false);
  });

  it('last_dialed_at is the max admitted_at over COUNTED dials only', () => {
    const m = reducePhoneProgress([
      engagement('c1', {
        phone_call_attempts: [
          attempt({ admitted_at: T(2) }),
          // Later, but never rang: must not become "last dialled".
          attempt({ state: 'abandoned', abandon_reason: 'infra_deferred', outcome_class: null, admitted_at: T(8) }),
          attempt({ outcome_class: 'provider_error', admitted_at: T(9) }),
          attempt({ admitted_at: T(1) }),
        ],
      }),
    ]);
    expect(m.get('c1')?.last_dialed_at).toBe(T(2));
  });

  it('only infra-deferred attempts: dial_count 0 and no last_dialed_at', () => {
    const m = reducePhoneProgress([
      engagement('c1', {
        state: 'eligible',
        phone_call_attempts: [attempt({ state: 'abandoned', abandon_reason: 'infra_deferred', outcome_class: null })],
      }),
    ]);
    expect(m.get('c1')).toMatchObject({ dial_count: 0, last_dialed_at: null });
  });

  it('an attempts embed that is not an array makes that candidate UNKNOWN, never a low count', () => {
    const m = reducePhoneProgress([
      engagement('c1', { phone_call_attempts: [attempt(), attempt()] }),
      engagement('c1', { cycle_number: 2, phone_call_attempts: null }),
      engagement('c2', { phone_call_attempts: [attempt()] }),
    ]);
    expect(m.get('c1')).toEqual({ dial_count: null, phone_state: null, phone_state_reason: null, last_dialed_at: null });
    expect(m.get('c2')?.dial_count).toBe(1);
  });

  it('an unknown engagement state is reported as null, never echoed', () => {
    const m = reducePhoneProgress([engagement('c1', { state: 'some_future_state' })]);
    expect(m.get('c1')?.phone_state).toBeNull();
  });

  it('ignores rows without a candidate id', () => {
    const m = reducePhoneProgress([{ state: 'eligible', phone_call_attempts: [] }, engagement('c1')]);
    expect([...m.keys()]).toEqual(['c1']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The reason allowlist (critique A5: no new viewer exposure)
// ═══════════════════════════════════════════════════════════════════════

describe('phone_state_reason allowlist', () => {
  it('passes an allowlisted code through', () => {
    for (const reason of PHONE_PROGRESS_REASON_ALLOWLIST) expect(projectPhoneStateReason(reason)).toBe(reason);
  });

  it('turns free text, an unlisted code or a non-string into null', () => {
    expect(projectPhoneStateReason('called +91 98765 43210 and spoke to Jane')).toBeNull();
    expect(projectPhoneStateReason('duplicate_application')).toBeNull();
    expect(projectPhoneStateReason('phone_invalid')).toBeNull();
    expect(projectPhoneStateReason('')).toBeNull();
    expect(projectPhoneStateReason(null)).toBeNull();
    expect(projectPhoneStateReason(42)).toBeNull();
  });

  it('the reducer applies it to the latest cycle', () => {
    const m = reducePhoneProgress([engagement('c1', { state: 'failed', state_reason: 'sip trunk said: Jane Doe busy' })]);
    expect(m.get('c1')?.phone_state).toBe('failed');
    expect(m.get('c1')?.phone_state_reason).toBeNull();
  });

  it('is EXACTLY the keys of the web ENGAGEMENT_REASON_LABELS map', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../web/src/components/talent/status.ts', import.meta.url)),
      'utf8',
    );
    const block = /const ENGAGEMENT_REASON_LABELS[^{]*\{([\s\S]*?)\n\};/.exec(src);
    expect(block, 'ENGAGEMENT_REASON_LABELS not found in web status.ts').not.toBeNull();
    const webKeys = [...block![1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
    expect(webKeys.length).toBeGreaterThan(10);
    expect([...PHONE_PROGRESS_REASON_ALLOWLIST].sort()).toEqual([...webKeys].sort());
  });

  it('covers every reason the outcome machine can write', () => {
    const written = new Set(Object.values(PHONE_OUTCOME_MIGRATION_REASONS).flat());
    for (const reason of written) expect(PHONE_PROGRESS_REASON_ALLOWLIST).toContain(reason);
  });

  it('the restated engagement states equal the 0042 vocabulary', () => {
    expect([...PHONE_PROGRESS_ENGAGEMENT_STATES]).toEqual([...PHONE_ENGAGEMENT_STATES]);
  });

  it('openapi documents the same two enums', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../../openapi/openapi.yaml', import.meta.url)), 'utf8')
      .replace(/\r\n/g, '\n');
    const enumOf = (name: string): string[] => {
      const m = new RegExp(`\\n    ${name}:\\n(?:      .*\\n)*?      enum: \\[([^\\]]*)\\]`).exec(yaml);
      expect(m, `${name} enum not found in openapi.yaml`).not.toBeNull();
      return m![1].split(',').map((s) => s.trim());
    };
    expect(enumOf('CandidatePhoneState')).toEqual([...PHONE_PROGRESS_ENGAGEMENT_STATES]);
    expect(enumOf('CandidatePhoneStateReason')).toEqual([...PHONE_PROGRESS_REASON_ALLOWLIST]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. The loader: chunking, row cap, degradation
// ═══════════════════════════════════════════════════════════════════════

describe('loadPhoneProgress', () => {
  it('returns an empty map and issues no query for no ids', async () => {
    configure({});
    expect((await loadPhoneProgress([])).size).toBe(0);
    expect(fromCalls).toEqual([]);
  });

  it('reads a narrow, named column list with attempts embedded — nothing sensitive', async () => {
    configure({ phone_engagements: ok([]) });
    await loadPhoneProgress(['c1']);
    const sel = selects.find((s) => s.table === 'phone_engagements');
    expect(sel?.columns).toBe(PHONE_PROGRESS_SELECT);
    expect(String(sel?.columns)).toContain('phone_call_attempts (');
    expect(String(sel?.columns)).not.toMatch(/\*|sip|room|lease|egress|recording|phone_e164|phone_raw|session/);
    expect(inCalls).toEqual([{ table: 'phone_engagements', column: 'candidate_id', values: ['c1'] }]);
  });

  it('every requested id is present: progress, never-engaged (0), or unknown (null)', async () => {
    configure({ phone_engagements: ok([engagement('c1', { phone_call_attempts: [attempt()] })]) });
    const m = await loadPhoneProgress(['c1', 'c2']);
    expect(m.get('c1')?.dial_count).toBe(1);
    expect(m.get('c2')).toEqual({ dial_count: 0, phone_state: null, phone_state_reason: null, last_dialed_at: null });
  });

  it(`chunks ids at ${PHONE_PROGRESS_CHUNK_SIZE} per query`, async () => {
    expect(PHONE_PROGRESS_CHUNK_SIZE).toBeLessThanOrEqual(100);
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    configure({ phone_engagements: ({ inValues }) => ok((inValues ?? []).map((id) => engagement(id, { phone_call_attempts: [attempt()] }))) });
    const m = await loadPhoneProgress(ids);
    const calls = inCalls.filter((c) => c.table === 'phone_engagements');
    expect(calls.map((c) => c.values.length)).toEqual([100, 100, 50]);
    expect(new Set(calls.flatMap((c) => c.values)).size).toBe(250);
    expect(m.size).toBe(250);
    expect([...m.values()].every((p) => p.dial_count === 1)).toBe(true);
    expect(chunkIds(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });

  it('de-duplicates ids before chunking', async () => {
    configure({ phone_engagements: ok([]) });
    await loadPhoneProgress(['c1', 'c1', 'c2']);
    expect(inCalls[0].values).toEqual(['c1', 'c2']);
  });

  it(`a chunk returning >= ${PHONE_PROGRESS_ROW_CAP} rows is UNKNOWN (possible silent truncation), others unaffected`, async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
    configure({
      phone_engagements: ({ call, inValues }) => {
        if (call === 0) {
          // First chunk: exactly at the cap — PostgREST may have cut it short.
          return ok(Array.from({ length: PHONE_PROGRESS_ROW_CAP }, (_, i) =>
            engagement(inValues![i % inValues!.length], { phone_call_attempts: [attempt()] })));
        }
        return ok((inValues ?? []).map((id) => engagement(id, { phone_call_attempts: [attempt(), attempt()] })));
      },
    });
    const m = await loadPhoneProgress(ids);
    for (const id of ids.slice(0, 100)) {
      expect(m.get(id)).toEqual({ dial_count: null, phone_state: null, phone_state_reason: null, last_dialed_at: null });
    }
    for (const id of ids.slice(100)) expect(m.get(id)?.dial_count).toBe(2);
  });

  it('one row under the cap is still trusted', async () => {
    configure({
      phone_engagements: ({ inValues }) => ok(Array.from({ length: PHONE_PROGRESS_ROW_CAP - 1 }, () =>
        engagement(inValues![0], { phone_call_attempts: [attempt()] }))),
    });
    const m = await loadPhoneProgress(['c1']);
    expect(m.get('c1')?.dial_count).toBe(PHONE_PROGRESS_ROW_CAP - 1);
  });

  it('a read ERROR degrades that chunk to unknown', async () => {
    configure({ phone_engagements: { data: null, error: { message: 'relation does not exist' } } });
    const m = await loadPhoneProgress(['c1']);
    expect(m.get('c1')).toEqual({ dial_count: null, phone_state: null, phone_state_reason: null, last_dialed_at: null });
  });

  it('a THROWN error degrades to unknown and never rejects', async () => {
    configure({ phone_engagements: new Error('pooler reset') });
    await expect(loadPhoneProgress(['c1'])).resolves.toEqual(new Map([['c1', {
      dial_count: null, phone_state: null, phone_state_reason: null, last_dialed_at: null,
    }]]));
  });

  it('a non-array payload is unknown, not "never dialled"', async () => {
    configure({ phone_engagements: ok({ candidate_id: 'c1' }) });
    expect((await loadPhoneProgress(['c1'])).get('c1')?.dial_count).toBeNull();
  });

  it('only the failing chunk degrades', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `c${i}`);
    configure({
      phone_engagements: ({ call, inValues }) => call === 1
        ? { data: null, error: { message: 'timeout' } }
        : ok((inValues ?? []).map((id) => engagement(id))),
    });
    const m = await loadPhoneProgress(ids);
    expect(m.get('c0')?.dial_count).toBe(0);
    expect(m.get('c119')?.dial_count).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. The routes
// ═══════════════════════════════════════════════════════════════════════

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = 'Bearer ' + JWT;

const admin: AuthUser = {
  id: 'user-admin-0000-0000-000000000001', email: 'admin@example.com',
  aal: 'aal2', active: true, appRole: 'admin', orgId: 'org-0000-0000-0000-000000000001',
};
const interviewer: AuthUser = { ...admin, id: 'user-int-0000-0000-000000000002', appRole: 'interviewer' };
const viewer: AuthUser = { ...admin, id: 'user-view-0000-0000-000000000003', appRole: 'viewer' };

function appFor(user: AuthUser) {
  return createApp({
    nodeEnv: 'test', webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT) },
    auditSinkOverride: async () => {},
  });
}

const CAND_ID = '11111111-1111-4111-8111-111111111111';
const candidateRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: 'Ada Lovelace', email: 'ada@example.com', phone_e164: '+919876543210', phone_valid: true,
  skills: [], experience_years: 3, status: 'queued', role_id: null,
  created_at: '2026-10-01T00:00:00Z', decision_use_blocked_at: null, ...over,
});

const DIALLED = [
  engagement('cand_a', {
    cycle_number: 1, state: 'abandoned_no_answer', state_reason: 'no_answer_budget_exhausted',
    phone_call_attempts: [
      attempt({ admitted_at: T(1) }),
      attempt({ admitted_at: T(2) }),
      attempt({ state: 'abandoned', abandon_reason: null, outcome_class: null, admitted_at: T(3) }),
      attempt({ state: 'abandoned', abandon_reason: 'infra_deferred', outcome_class: null, admitted_at: T(4) }),
    ],
  }),
];

describe('GET /api/candidates — phone progress fields', () => {
  it('adds dial_count, phone_state, phone_state_reason and last_dialed_at to every row', async () => {
    configure({
      candidates: ok([candidateRow('cand_a'), candidateRow('cand_b', { status: 'new' })]),
      assessments: ok([]),
      phone_engagements: ok(DIALLED),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    const [a, b] = res.body;
    expect(a).toMatchObject({
      id: 'cand_a', status: 'queued',
      dial_count: 3, phone_state: 'abandoned_no_answer',
      phone_state_reason: 'no_answer_budget_exhausted', last_dialed_at: T(3),
    });
    // Never engaged: a real 0, not unknown.
    expect(b).toMatchObject({ id: 'cand_b', dial_count: 0, phone_state: null, phone_state_reason: null, last_dialed_at: null });
  });

  it('a phone read FAILURE still returns 200, with every phone field null (unknown)', async () => {
    configure({
      candidates: ok([candidateRow('cand_a')]),
      assessments: ok([]),
      phone_engagements: { data: null, error: { message: 'permission denied' } },
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ dial_count: null, phone_state: null, phone_state_reason: null, last_dialed_at: null });
    expect(res.body[0].status).toBe('queued');
  });

  it('a THROWN phone read still returns 200', async () => {
    configure({
      candidates: ok([candidateRow('cand_a')]),
      assessments: ok([]),
      phone_engagements: new Error('socket hang up'),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].dial_count).toBeNull();
  });

  it('50 candidates issue exactly ONE phone_engagements query, scoped by in(candidate_id)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => candidateRow(`cand_${i}`));
    configure({ candidates: ok(many), assessments: ok([]), phone_engagements: ok([]) });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body).toHaveLength(50);
    expect(fromCalls.filter((t) => t === 'phone_engagements')).toHaveLength(1);
    const scoped = inCalls.find((c) => c.table === 'phone_engagements');
    expect(scoped?.column).toBe('candidate_id');
    expect(scoped?.values).toHaveLength(50);
  });

  it('250 candidates issue 3 chunked queries, no N+1', async () => {
    const many = Array.from({ length: 250 }, (_, i) => candidateRow(`cand_${i}`));
    configure({ candidates: ok(many), assessments: ok([]), phone_engagements: ok([]) });
    await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(fromCalls.filter((t) => t === 'phone_engagements')).toHaveLength(3);
  });

  it('an empty list issues no phone query', async () => {
    configure({ candidates: ok([]), assessments: ok([]) });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body).toEqual([]);
    expect(fromCalls).not.toContain('phone_engagements');
  });

  it("an interviewer's phone query covers ONLY the ids the owner-scoped candidate query returned", async () => {
    configure({
      candidates: ok([candidateRow('cand_mine')]),
      assessments: ok([]),
      phone_engagements: ok([]),
    });
    await request(appFor(interviewer)).get('/api/candidates').set('Authorization', AUTH);
    expect(eqCalls).toContainEqual({ table: 'candidates', column: 'owner_id', value: interviewer.id });
    expect(inCalls.find((c) => c.table === 'phone_engagements')?.values).toEqual(['cand_mine']);
  });

  it('viewer, interviewer and admin all receive the fields', async () => {
    for (const user of [viewer, interviewer, admin]) {
      configure({ candidates: ok([candidateRow('cand_a')]), assessments: ok([]), phone_engagements: ok(DIALLED) });
      const res = await request(appFor(user)).get('/api/candidates').set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body[0].dial_count).toBe(3);
      expect(res.body[0].phone_state).toBe('abandoned_no_answer');
    }
  });

  it('a free-text reason never crosses the viewer-level boundary', async () => {
    configure({
      candidates: ok([candidateRow('cand_a')]),
      assessments: ok([]),
      phone_engagements: ok([engagement('cand_a', { state: 'failed', state_reason: 'Jane said call +919876543210 later' })]),
    });
    const res = await request(appFor(viewer)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0].phone_state).toBe('failed');
    expect(res.body[0].phone_state_reason).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Jane said');
    // The viewer still gets the number redacted, as before.
    expect(res.body[0].phone_e164).toBeNull();
  });

  it('a decided status is reported as-is: the API never rewrites status', async () => {
    configure({
      candidates: ok([candidateRow('cand_a', { status: 'screened' })]),
      assessments: ok([]),
      phone_engagements: ok([engagement('cand_a', { state: 'failed', state_reason: 'assessment_aborted', phone_call_attempts: [attempt()] })]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0]).toMatchObject({ status: 'screened', phone_state: 'failed', dial_count: 1 });
  });
});

describe('GET /api/candidates/:id — phone progress fields', () => {
  it('candidate carries the same four fields, read for the authorized id only', async () => {
    configure({
      candidates: ok(candidateRow(CAND_ID)),
      call_sessions: ok([]),
      assessments: ok([]),
      phone_engagements: ok([engagement(CAND_ID, {
        state: 'awaiting_retry',
        phone_call_attempts: [attempt({ admitted_at: T(2) }), attempt({ admitted_at: T(5) }), attempt({ admitted_at: T(3) })],
      })]),
    });
    const res = await request(appFor(admin)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.candidate).toMatchObject({
      id: CAND_ID, status: 'queued',
      dial_count: 3, phone_state: 'awaiting_retry', phone_state_reason: null, last_dialed_at: T(5),
    });
    expect(inCalls.find((c) => c.table === 'phone_engagements')?.values).toEqual([CAND_ID]);
  });

  it('a never-engaged candidate reports dial_count 0', async () => {
    configure({ candidates: ok(candidateRow(CAND_ID)), call_sessions: ok([]), assessments: ok([]), phone_engagements: ok([]) });
    const res = await request(appFor(viewer)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(res.body.candidate).toMatchObject({ dial_count: 0, phone_state: null, phone_state_reason: null, last_dialed_at: null });
  });

  it('a phone read failure degrades to null and the page still loads', async () => {
    configure({
      candidates: ok(candidateRow(CAND_ID)),
      call_sessions: ok([]),
      assessments: ok([]),
      phone_engagements: { data: null, error: { message: 'boom' } },
    });
    const res = await request(appFor(viewer)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.candidate).toMatchObject({ dial_count: null, phone_state: null, phone_state_reason: null, last_dialed_at: null });
    // Redaction is unchanged for a viewer.
    expect(res.body.candidate.phone_e164).toBeNull();
  });

  it('a candidate the interviewer cannot see is a 404 with no phone read', async () => {
    configure({ candidates: { data: null, error: { message: 'no rows' } } });
    const res = await request(appFor(interviewer)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(404);
    expect(fromCalls).not.toContain('phone_engagements');
  });
});
