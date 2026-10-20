/**
 * GET /api/candidates — the ONE sanitized `resume_review` field, and the
 * truthfulness of a PII-minimal shell in the list.
 *
 * A candidate created at import time has NULL name and email until a resume is
 * parsed. That is deliberate — the shell carries no candidate PII at all — so
 * the list contract has to be honest about it rather than fabricating a name.
 * `resume_review` is what makes such a row legible; it is the only thing about
 * the Ashby integration that crosses this boundary.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { projectResumeReview, resolveIntakeType } from '../routes/candidates.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = 'Bearer ' + JWT;

const admin: AuthUser = {
  id: 'user-admin-0000-0000-000000000001', email: 'admin@example.com',
  aal: 'aal2', active: true, appRole: 'admin', orgId: 'org-0000-0000-0000-000000000001',
};
const interviewer: AuthUser = { ...admin, id: 'user-int-0000-0000-000000000002', appRole: 'interviewer' };

const mockFrom = vi.fn();
const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
const inCalls: Array<{ table: string; column: string; values: unknown }> = [];
const selects: Array<{ table: string; columns: unknown }> = [];
const fromCalls: string[] = [];

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
  RESUME_BUCKET: 'resumes_v2',
}));

function chain(table: string, value: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const methods = ['insert', 'update', 'upsert', 'delete', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'not', 'order', 'limit', 'range', 'single', 'maybeSingle'];
  for (const m of methods) c[m] = () => chain(table, value);
  c.select = (columns: unknown) => { selects.push({ table, columns }); return chain(table, value); };
  c.eq = (column: string, v: unknown) => { eqCalls.push({ table, column, value: v }); return chain(table, value); };
  c.in = (column: string, values: unknown) => { inCalls.push({ table, column, values }); return chain(table, value); };
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

function configure(config: Record<string, unknown>): void {
  mockFrom.mockImplementation((table: string) => {
    fromCalls.push(table);
    return chain(table, config[table] ?? { data: null, error: null });
  });
}

function appFor(user: AuthUser) {
  return createApp({
    nodeEnv: 'test', webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT) },
    auditSinkOverride: async () => {},
  });
}

const ok = (data: unknown) => ({ data, error: null });

/** A PII-minimal shell exactly as `insertCandidateShell` writes it. */
const SHELL = {
  id: 'cand_shell_1', name: null, email: null, phone_e164: null, phone_valid: false,
  skills: [], experience_years: null, status: 'queued', role_id: 'role_1',
  created_at: '2026-08-21T00:00:00Z', decision_use_blocked_at: null,
};

const PARSED_CANDIDATE = {
  id: 'cand_full_1', name: 'Ada Lovelace', email: 'ada@example.com', phone_e164: null,
  phone_valid: false, skills: ['analysis'], experience_years: 7, status: 'queued',
  role_id: 'role_1', created_at: '2026-08-20T00:00:00Z', decision_use_blocked_at: null,
};

/** A resume row id (a uuid, not PII): what a dashboard upload carries. */
const RESUME_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0; inCalls.length = 0; selects.length = 0; fromCalls.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════
// 1. The pure projection
// ═══════════════════════════════════════════════════════════════════════

describe('projectResumeReview', () => {
  it('collapses the five in-flight states to `processing`', () => {
    for (const s of ['queued', 'fetching', 'scanning', 'extracting', 'structuring']) {
      expect(projectResumeReview(s)).toBe('processing');
    }
  });

  it('maps the terminal states', () => {
    expect(projectResumeReview('ready')).toBe('ready');
    expect(projectResumeReview('cancelled')).toBe('cancelled');
  });

  it('`failed_review` becomes `needs_review` and says NOTHING about why', () => {
    // The nine parse causes, the scan verdicts and the guard rejections are
    // operator information and live behind the admin-gated Mission Control. A
    // recruiter list is not the place to disclose that a document was
    // rejected by a malware scanner.
    expect(projectResumeReview('failed_review')).toBe('needs_review');
  });

  it('an unknown or absent state is null, never guessed', () => {
    expect(projectResumeReview(undefined)).toBeNull();
    expect(projectResumeReview(null)).toBeNull();
    expect(projectResumeReview('some_future_state')).toBeNull();
    expect(projectResumeReview(7)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The list contract
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/candidates — resume_review', () => {
  it('a PII-minimal shell is returned TRUTHFULLY: null name/email, needs_review', async () => {
    configure({
      candidates: ok([SHELL]),
      assessments: ok([]),
      ashby_application_links: ok([
        { candidate_id: 'cand_shell_1', updated_at: '2026-08-21T00:00:00Z',
          ashby_resume_ingestions: [{ state: 'failed_review' }] },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    // No fabricated identity. The shell holds no candidate PII and the list
    // reports exactly that.
    expect(row.name).toBeNull();
    expect(row.email).toBeNull();
    expect(row.status).toBe('queued');
    expect(row.resume_review).toBe('needs_review');
  });

  it('reports `processing` while the ingestion is in flight and `ready` once parsed', async () => {
    for (const [state, expected] of [['extracting', 'processing'], ['ready', 'ready']] as const) {
      vi.clearAllMocks();
      configure({
        candidates: ok([PARSED_CANDIDATE]),
        assessments: ok([]),
        ashby_application_links: ok([
          { candidate_id: 'cand_full_1', updated_at: '2026-08-21T00:00:00Z',
            ashby_resume_ingestions: [{ state }] },
        ]),
      });
      const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
      expect(res.body[0].resume_review).toBe(expected);
    }
  });

  it('a NON-Ashby candidate reports null', async () => {
    configure({
      candidates: ok([{ ...PARSED_CANDIDATE, id: 'cand_manual' }]),
      assessments: ok([]),
      ashby_application_links: ok([]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0].resume_review).toBeNull();
  });

  it('a link with no ingestion row embedded reports null rather than guessing', async () => {
    configure({
      candidates: ok([PARSED_CANDIDATE]),
      assessments: ok([]),
      ashby_application_links: ok([
        { candidate_id: 'cand_full_1', updated_at: '2026-08-21T00:00:00Z', ashby_resume_ingestions: [] },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0].resume_review).toBeNull();
  });

  it('ONE extra bounded query for the whole page — no N+1', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...SHELL, id: `cand_${i}` }));
    configure({
      candidates: ok(many),
      assessments: ok([]),
      ashby_application_links: ok(
        many.map((c) => ({
          candidate_id: c.id, updated_at: '2026-08-21T00:00:00Z',
          ashby_resume_ingestions: [{ state: 'failed_review' }],
        })),
      ),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body).toHaveLength(50);
    expect(res.body.every((r: { resume_review: string }) => r.resume_review === 'needs_review')).toBe(true);
    // 50 candidates ⇒ exactly one links query, not fifty.
    expect(fromCalls.filter((t) => t === 'ashby_application_links')).toHaveLength(1);
    // And it is scoped by an `in (...)` over the page's candidate set.
    const scoped = inCalls.find((c) => c.table === 'ashby_application_links');
    expect(scoped?.column).toBe('candidate_id');
    expect((scoped?.values as string[]).length).toBe(50);
  });

  it('a link read FAILURE degrades to null and never fails the list', async () => {
    configure({
      candidates: ok([SHELL]),
      assessments: ok([]),
      ashby_application_links: { data: null, error: { message: 'relation missing' } },
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].resume_review).toBeNull();
  });

  it('interviewer OWNER scoping is unchanged and still applied to the candidate query', async () => {
    configure({ candidates: ok([]), assessments: ok([]), ashby_application_links: ok([]) });
    await request(appFor(interviewer)).get('/api/candidates').set('Authorization', AUTH);
    expect(eqCalls).toContainEqual({ table: 'candidates', column: 'owner_id', value: interviewer.id });
  });

  it('the row shape is otherwise byte-identical — only resume_review, intake_type, ashby_job_status and the four phone-progress fields are added', async () => {
    configure({
      candidates: ok([{ ...PARSED_CANDIDATE, resume_id: RESUME_ID }]),
      assessments: ok([]),
      ashby_application_links: ok([]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    // dial_count / last_dialed_at / phone_state / phone_state_reason come from
    // lib/candidate-phone-progress.ts (candidates-phone-progress.test.ts).
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'ashby_job_status', 'created_at', 'dial_count', 'email', 'experience_years', 'id', 'intake_type',
      'last_dialed_at', 'latest_recommendation', 'latest_score', 'name', 'phone_e164', 'phone_state',
      'phone_state_reason', 'phone_valid', 'resume_review', 'role_id', 'skills', 'status',
    ]);
    // The internal suppression field never leaks, as before; nor does
    // `resume_id`, which only drives the intake rule.
    expect(res.body[0]).not.toHaveProperty('decision_use_blocked_at');
    expect(res.body[0]).not.toHaveProperty('resume_id');
  });

  it('NO link id, external Ashby id, failure reason, or attempt count crosses the boundary', async () => {
    configure({
      candidates: ok([SHELL]),
      assessments: ok([]),
      ashby_application_links: ok([
        {
          candidate_id: 'cand_shell_1', updated_at: '2026-08-21T00:00:00Z',
          ashby_resume_ingestions: [{ state: 'failed_review' }],
        },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    const blob = JSON.stringify(res.body);
    expect(blob).not.toMatch(/parse_|scan_|guard_|failed_reason|attempts/);
    expect(blob).not.toMatch(/application_link|external_application|file_handle/);
    // The SELECT itself is a narrow allowlist — it cannot over-read.
    const linkSelect = selects.find((s) => s.table === 'ashby_application_links');
    expect(linkSelect!.columns).toBe('candidate_id, updated_at, job_mapping_id, intake_type, ashby_resume_ingestions ( state )');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. ashby_job_status — per-candidate attribution through the link's mapping
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/candidates — ashby_job_status', () => {
  const link = (candidate_id: string, job_mapping_id: string | null, updated_at = '2026-08-21T00:00:00Z') => ({
    candidate_id, updated_at, job_mapping_id, ashby_resume_ingestions: [{ state: 'ready' }],
  });
  const cand = (id: string) => ({ ...PARSED_CANDIDATE, id });

  it('reports the status of the mapping each candidate OWN link points at (same role, different jobs)', async () => {
    configure({
      candidates: ok([cand('c_live'), cand('c_paused'), cand('c_drift'), cand('c_nolink')]),
      assessments: ok([]),
      ashby_application_links: ok([
        link('c_live', 'map_live'), link('c_paused', 'map_paused'), link('c_drift', 'map_drift'),
      ]),
      ashby_job_mappings: ok([
        { id: 'map_live', status: 'enabled' },
        { id: 'map_paused', status: 'paused' },
        { id: 'map_drift', status: 'drift' },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    const by = Object.fromEntries(res.body.map((r: { id: string; ashby_job_status: unknown }) => [r.id, r.ashby_job_status]));
    expect(by).toEqual({ c_live: 'enabled', c_paused: 'paused', c_drift: 'drift', c_nolink: null });
  });

  it('is null for an archived or missing mapping (archived rows are filtered out of the read)', async () => {
    configure({
      candidates: ok([cand('c_arch')]),
      assessments: ok([]),
      ashby_application_links: ok([link('c_arch', 'map_archived')]),
      ashby_job_mappings: ok([]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0].ashby_job_status).toBeNull();
  });

  it('the most recently updated link wins when a candidate has several', async () => {
    configure({
      candidates: ok([cand('c_two')]),
      assessments: ok([]),
      ashby_application_links: ok([link('c_two', 'map_new', '2026-09-01T00:00:00Z'), link('c_two', 'map_old', '2026-08-01T00:00:00Z')]),
      ashby_job_mappings: ok([{ id: 'map_new', status: 'paused' }, { id: 'map_old', status: 'enabled' }]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0].ashby_job_status).toBe('paused');
  });

  it('OMITS ashby_job_status from every row when the mappings read fails', async () => {
    configure({
      candidates: ok([cand('c_a'), cand('c_b')]),
      assessments: ok([]),
      ashby_application_links: ok([link('c_a', 'map_x'), link('c_b', 'map_x')]),
      ashby_job_mappings: { data: null, error: { message: 'boom' } },
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    for (const r of res.body) expect('ashby_job_status' in r).toBe(false);
  });

  it('OMITS ashby_job_status from every row when the links read fails', async () => {
    configure({
      candidates: ok([cand('c_a')]),
      assessments: ok([]),
      ashby_application_links: { data: null, error: { message: 'boom' } },
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect('ashby_job_status' in res.body[0]).toBe(false);
  });

  it('the NEWEST link decides even when its mapping was deleted (null job_mapping_id)', async () => {
    configure({
      candidates: ok([cand('c_del')]),
      assessments: ok([]),
      ashby_application_links: ok([link('c_del', null, '2026-09-01T00:00:00Z'), link('c_del', 'map_old', '2026-08-01T00:00:00Z')]),
      ashby_job_mappings: ok([{ id: 'map_old', status: 'enabled' }]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0].ashby_job_status).toBeNull();
  });

  it('pages the links read past the PostgREST row cap, and omits the field if the page ceiling is hit', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => link('c_p', i === 0 ? 'map_new' : 'map_old', '2026-09-01T00:00:00Z'));
    // Every page is full -> ceiling reached -> status unknown -> omitted.
    configure({
      candidates: ok([cand('c_p')]),
      assessments: ok([]),
      ashby_application_links: ok(full),
      ashby_job_mappings: ok([{ id: 'map_new', status: 'paused' }]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect('ashby_job_status' in res.body[0]).toBe(false);
    expect(fromCalls.filter((t) => t === 'ashby_application_links').length).toBeGreaterThan(1);
  });

  it('is batched: one mappings read for the page, scoped to non-archived ids; never fails the list', async () => {
    configure({
      candidates: ok([cand('c_a'), cand('c_b')]),
      assessments: ok([]),
      ashby_application_links: ok([link('c_a', 'map_x'), link('c_b', 'map_x')]),
      ashby_job_mappings: { data: null, error: { message: 'boom' } },
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.every((r: Record<string, unknown>) => !('ashby_job_status' in r))).toBe(true);
    expect(fromCalls.filter((t) => t === 'ashby_job_mappings')).toHaveLength(1);
    const scoped = inCalls.find((c) => c.table === 'ashby_job_mappings');
    expect(scoped).toEqual({ table: 'ashby_job_mappings', column: 'id', values: ['map_x'] });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. intake_type (M017 Addendum A) — one rule, list and detail
// ═══════════════════════════════════════════════════════════════════════

describe('resolveIntakeType — the one rule', () => {
  it('the newest link decides, whatever it holds', () => {
    expect(resolveIntakeType({ intakeType: 'phone_parsing' }, RESUME_ID)).toBe('phone_parsing');
    expect(resolveIntakeType({ intakeType: 'resume_parsing' }, null)).toBe('resume_parsing');
    // A link holding a value outside the CHECK is null even with a resume:
    // the link is authoritative and is never second-guessed by resume_id.
    expect(resolveIntakeType({ intakeType: null }, RESUME_ID)).toBeNull();
  });

  it('no link: a resume on file (dashboard upload) is resume_parsing, otherwise null', () => {
    expect(resolveIntakeType(null, RESUME_ID)).toBe('resume_parsing');
    for (const none of [null, undefined, '', 7]) expect(resolveIntakeType(null, none)).toBeNull();
  });
});

describe('GET /api/candidates — intake_type', () => {
  const cand = (id: string, resume_id: string | null = null) => ({ ...PARSED_CANDIDATE, id, resume_id });
  const link = (candidate_id: string, intake_type: unknown, state: string, updated_at = '2026-10-20T00:00:00Z') => ({
    candidate_id, updated_at, job_mapping_id: null, intake_type, ashby_resume_ingestions: { state },
  });

  it('a phone-parsing row reports phone_parsing and resume_review null, whatever its ingestion row says', async () => {
    configure({
      candidates: ok([cand('c_queued'), cand('c_fellback')]),
      assessments: ok([]),
      ashby_application_links: ok([
        // The harmless leftover `queued` row (M017 §1.2) ...
        link('c_queued', 'phone_parsing', 'queued'),
        // ... and an unreadable resume that fell back (Addendum B3).
        link('c_fellback', 'phone_parsing', 'failed_review'),
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    for (const row of res.body) {
      expect(row.intake_type, row.id).toBe('phone_parsing');
      expect(row.resume_review, row.id).toBeNull();
    }
  });

  it('a resume-parsing link keeps its resume_review exactly as before', async () => {
    configure({
      candidates: ok([cand('c_resume')]),
      assessments: ok([]),
      ashby_application_links: ok([link('c_resume', 'resume_parsing', 'failed_review')]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0]).toMatchObject({ intake_type: 'resume_parsing', resume_review: 'needs_review' });
  });

  it('a dashboard upload (no Ashby link, resume_id set) reports resume_parsing; no link and no resume is null', async () => {
    configure({
      candidates: ok([cand('c_upload', RESUME_ID), cand('c_bare')]),
      assessments: ok([]),
      ashby_application_links: ok([]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    const by = Object.fromEntries(res.body.map((r: { id: string; intake_type: unknown }) => [r.id, r.intake_type]));
    expect(by).toEqual({ c_upload: 'resume_parsing', c_bare: null });
    // resume_id is read for the rule (never the resume handle) and not emitted.
    const candidateSelect = selects.find((s) => s.table === 'candidates');
    expect(String(candidateSelect!.columns).split(',')).toContain('resume_id');
    expect(String(candidateSelect!.columns)).not.toMatch(/handle/);
    for (const row of res.body) expect(row).not.toHaveProperty('resume_id');
  });

  it('the NEWEST link wins when a candidate holds several', async () => {
    configure({
      candidates: ok([cand('c_two', RESUME_ID)]),
      assessments: ok([]),
      ashby_application_links: ok([
        link('c_two', 'phone_parsing', 'queued', '2026-10-20T00:00:00Z'),
        link('c_two', 'resume_parsing', 'ready', '2026-09-01T00:00:00Z'),
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0]).toMatchObject({ intake_type: 'phone_parsing', resume_review: null });
  });

  it('a value outside the CHECK, or a pre-0130 row without the column, is null — never guessed', async () => {
    configure({
      candidates: ok([cand('c_odd', RESUME_ID), cand('c_old', RESUME_ID)]),
      assessments: ok([]),
      ashby_application_links: ok([
        link('c_odd', 'Phone Parsing', 'ready'),
        { candidate_id: 'c_old', updated_at: '2026-10-20T00:00:00Z', job_mapping_id: null, ashby_resume_ingestions: { state: 'ready' } },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    for (const row of res.body) {
      expect(row.intake_type, row.id).toBeNull();
      // resume_review is unaffected: a non-phone intake keeps today's value.
      expect(row.resume_review, row.id).toBe('ready');
    }
  });

  it('a link read FAILURE degrades to null — even with a resume on file — and never fails the list', async () => {
    configure({
      candidates: ok([cand('c_upload', RESUME_ID)]),
      assessments: ok([]),
      ashby_application_links: { data: null, error: { message: 'relation missing' } },
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].intake_type).toBeNull();
    expect(res.body[0].resume_review).toBeNull();
  });

  it('a TRUNCATED links read keeps what it saw and reports null for a candidate it did not reach', async () => {
    // Every page is full, so the read hits its page ceiling: incomplete.
    const full = Array.from({ length: 1000 }, () => link('c_seen', 'phone_parsing', 'queued'));
    configure({
      candidates: ok([cand('c_seen'), cand('c_unseen', RESUME_ID)]),
      assessments: ok([]),
      ashby_application_links: ok(full),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.map((r: { id: string; intake_type: unknown }) => [r.id, r.intake_type]));
    // c_unseen may hold a link the read never reached: unknown, not resume_parsing.
    expect(by).toEqual({ c_seen: 'phone_parsing', c_unseen: null });
  });

  it('adds no query: intake_type rides on the one links read', async () => {
    configure({
      candidates: ok([cand('c_a'), cand('c_b', RESUME_ID)]),
      assessments: ok([]),
      ashby_application_links: ok([link('c_a', 'phone_parsing', 'queued')]),
    });
    await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(fromCalls.filter((t) => t === 'ashby_application_links')).toHaveLength(1);
  });
});

describe('GET /api/candidates/:id — intake_type (same rule, same helper)', () => {
  const CAND_ID = '00000000-0000-4000-8000-000000000041';
  const detailRow = (resume_id: string | null) => ({
    ...PARSED_CANDIDATE, id: CAND_ID, resume_id, owner_id: null,
    ashby_phone_applied_at: resume_id ? null : '2026-10-20T05:00:00.000Z',
  });

  it('reports the newest link\'s intake, read for the authorized candidate only', async () => {
    configure({
      candidates: ok(detailRow(null)),
      ashby_application_links: ok({ intake_type: 'phone_parsing' }),
    });
    const res = await request(appFor(admin)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.candidate.intake_type).toBe('phone_parsing');
    expect(eqCalls).toContainEqual({ table: 'ashby_application_links', column: 'candidate_id', value: CAND_ID });
    expect(eqCalls).toContainEqual({ table: 'ashby_application_links', column: 'provider', value: 'ashby' });
    expect(selects.find((s) => s.table === 'ashby_application_links')!.columns).toBe('intake_type');
    // The once-only marker reaches the detail through select('*'): a time, never a number.
    expect(res.body.candidate.ashby_phone_applied_at).toBe('2026-10-20T05:00:00.000Z');
  });

  it('a dashboard upload (no link, resume_id set) is resume_parsing; no link and no resume is null', async () => {
    configure({ candidates: ok(detailRow(RESUME_ID)), ashby_application_links: ok(null) });
    const upload = await request(appFor(admin)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(upload.body.candidate.intake_type).toBe('resume_parsing');

    configure({ candidates: ok(detailRow(null)), ashby_application_links: ok(null) });
    const bare = await request(appFor(admin)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(bare.body.candidate.intake_type).toBeNull();
  });

  it('a link read failure degrades to null and never fails the detail', async () => {
    configure({
      candidates: ok(detailRow(RESUME_ID)),
      ashby_application_links: { data: null, error: { message: 'relation missing' } },
    });
    const res = await request(appFor(admin)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.candidate.intake_type).toBeNull();
  });

  it('an unknown value is null; nothing else about the link crosses the boundary', async () => {
    configure({
      candidates: ok(detailRow(RESUME_ID)),
      ashby_application_links: ok({ intake_type: 'bogus', external_resume_file_handle: 'h'.repeat(40) }),
    });
    const res = await request(appFor(admin)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
    expect(res.body.candidate.intake_type).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('h'.repeat(40));
  });
});

describe('GET /api/integrations/ashby/review/:applicationLinkId — intake_type', () => {
  const CAND_ID = '00000000-0000-4000-8000-000000000042';
  const LINK_ID = '11111111-1111-4111-8111-111111111142';

  it('reports the ADDRESSED link\'s intake, through the same helper, in the shared envelope', async () => {
    configure({
      ashby_application_links: ok({ candidate_id: CAND_ID, intake_type: 'phone_parsing' }),
      candidates: ok({ ...PARSED_CANDIDATE, id: CAND_ID, resume_id: null, owner_id: null }),
    });
    const res = await request(appFor(admin)).get(`/api/integrations/ashby/review/${LINK_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.candidate.intake_type).toBe('phone_parsing');
    // The intake read is narrowed to the candidate AND the addressed link
    // (the link resolution itself filters by id too, hence two).
    const linkIdFilters = eqCalls.filter((c) => c.table === 'ashby_application_links' && c.column === 'id');
    expect(linkIdFilters).toHaveLength(2);
    expect(linkIdFilters.every((c) => c.value === LINK_ID)).toBe(true);
    expect(eqCalls).toContainEqual({ table: 'ashby_application_links', column: 'candidate_id', value: CAND_ID });
  });
});
