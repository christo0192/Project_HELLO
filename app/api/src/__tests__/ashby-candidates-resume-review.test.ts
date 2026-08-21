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
import { projectResumeReview } from '../routes/candidates.js';

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

  it('the row shape is otherwise byte-identical — exactly one field is added', async () => {
    configure({
      candidates: ok([PARSED_CANDIDATE]),
      assessments: ok([]),
      ashby_application_links: ok([]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'created_at', 'email', 'experience_years', 'id', 'latest_recommendation',
      'latest_score', 'name', 'phone_e164', 'phone_valid', 'resume_review',
      'role_id', 'skills', 'status',
    ]);
    // The internal suppression field never leaks, as before.
    expect(res.body[0]).not.toHaveProperty('decision_use_blocked_at');
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
    expect(linkSelect!.columns).toBe('candidate_id, updated_at, ashby_resume_ingestions ( state )');
  });
});
