/**
 * Phase 3-5 L4 Governance — GOV-04/05/10 tests.
 *
 * Covers:
 *   - Retention policy CRUD
 *   - Legal hold creation, release, and erasure blocking (negative)
 *   - DSAR create, export, delete (incl. legal hold block), correct
 *   - Consent boundary: job_application alone cannot unlock recording/outbound
 *   - D-009: retain-default does NOT mean no erasure
 *   - Audit trail for all governance actions
 *
 * Uses top-level vi.mock with module-level mock functions (same pattern as
 * recordings.test.ts and provider-resilience.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { setAuditSink } from '../lib/audit.js';

// ── Module-level mock state ──────────────────────────────────────────
// These are swapped by beforeEach. vi.mock factory captures them by ref.

let mockFromImpl: (tableName: string) => any;

// Hoisted mock — uses the mutable reference above
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from(tableName: string) {
      return mockFromImpl(tableName);
    },
    storage: {
      from() {
        return {
          createSignedUrl() {
            return Promise.resolve({ data: { signedUrl: 'https://example.com/signed-url' }, error: null });
          },
        };
      },
    },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

// ── Simple UUID counter ──────────────────────────────────────────────

let _idCounter = 0;
function nextId(): string {
  _idCounter++;
  return `00000000-0000-4000-8000-${String(_idCounter).padStart(12, '0')}`;
}
function ts(): string { return new Date().toISOString(); }

// ── In-memory governance database ────────────────────────────────────

interface TableStore {
  retentionPolicies: any[];
  legalHolds: any[];
  erasureExceptions: any[];
  dsarRequests: any[];
  governanceAudits: any[];
  candidates: any[];
  callSessions: any[];
  assessments: any[];
  transcriptTurns: any[];
  resumes: any[];
}

function freshTables(): TableStore {
  return {
    retentionPolicies: [
      { id: nextId(), data_category: 'candidate', retention_days: -1, strategy: 'archive', is_default: true, notes: 'D-009 default: retain indefinitely', created_by: null, created_at: ts(), updated_at: ts() },
      { id: nextId(), data_category: 'session', retention_days: -1, strategy: 'archive', is_default: true, notes: null, created_by: null, created_at: ts(), updated_at: ts() },
      { id: nextId(), data_category: 'recording', retention_days: -1, strategy: 'archive', is_default: true, notes: null, created_by: null, created_at: ts(), updated_at: ts() },
    ],
    legalHolds: [],
    erasureExceptions: [],
    dsarRequests: [],
    governanceAudits: [],
    candidates: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Alice Applicant', email: 'alice@example.com', skills: ['JavaScript', 'Python'], consent_source: 'recording_consent', owner_id: '22222222-2222-4222-8222-222222222222', created_at: ts(), updated_at: ts(), role_id: nextId(), phone_e164: '+15551234567', phone_valid: true, status: 'active', experience_years: 5, phone_raw: '+15551234567', parsed: null, consent_at: ts(), ats_external_id: null, ats_source: null, resume_id: null },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Bob Builder', email: 'bob@example.com', skills: ['Go', 'Rust'], consent_source: 'job_application', owner_id: '22222222-2222-4222-8222-222222222222', created_at: ts(), updated_at: ts(), role_id: nextId(), phone_e164: null, phone_valid: false, status: 'active', experience_years: 3, phone_raw: null, parsed: null, consent_at: ts(), ats_external_id: null, ats_source: null, resume_id: null },
    ],
    callSessions: [
      { id: '44444444-4444-4444-8444-444444444444', candidate_id: '11111111-1111-4111-8111-111111111111', mode: 'browser', status: 'completed', recording_object_key: 'recordings/session-001.webm', owner_id: '22222222-2222-4222-8222-222222222222', started_at: ts(), ended_at: ts(), duration_sec: 600 },
    ],
    assessments: [
      { id: nextId(), candidate_id: '11111111-1111-4111-8111-111111111111', overall_score: 85, recommendation: 'advance', summary: 'Strong candidate', created_at: ts() },
    ],
    transcriptTurns: [
      { id: nextId(), candidate_id: '11111111-1111-4111-8111-111111111111', speaker: 'bot', text: 'Tell me about your experience.', turn_index: 1, created_at: ts() },
    ],
    resumes: [
      { id: nextId(), candidate_id: '11111111-1111-4111-8111-111111111111', file_name: 'alice_resume.pdf', mime_type: 'application/pdf', text_extracted: 'Alice Applicant - 5 years experience', created_at: ts() },
    ],
  };
}

let tables: TableStore;

function makeFrom(tableName: string) {
  const source: any[] = (() => {
    switch (tableName) {
      case 'retention_policies': return tables.retentionPolicies;
      case 'legal_holds': return tables.legalHolds;
      case 'erasure_exceptions': return tables.erasureExceptions;
      case 'data_subject_requests': return tables.dsarRequests;
      case 'governance_audit': return tables.governanceAudits;
      case 'candidates': return tables.candidates;
      case 'call_sessions': return tables.callSessions;
      case 'assessments': return tables.assessments;
      case 'transcript_turns': return tables.transcriptTurns;
      case 'resumes': return tables.resumes;
      default: return [];
    }
  })();

  const filters: Array<(row: any) => boolean> = [];
  let sortField: string | undefined;
  let sortAsc = true;
  let limitCount: number | undefined;
  let rangeStart = 0;
  let single = false;
  let maybeSingle = false;
  let isInsert = false;
  let insertPayload: any;
  let isUpdate = false;
  let updatePayload: any;
  let isDelete = false;

  const q: any = {
    select() { return q; },
    eq(f: string, v: unknown) { filters.push((r: any) => r[f] === v); return q; },
    is(f: string, v: unknown) {
      if (v === null) filters.push((r: any) => r[f] === null || r[f] === undefined);
      else filters.push((r: any) => r[f] === v);
      return q;
    },
    not(f: string, _op: string, _v: unknown) { filters.push((r: any) => r[f] !== null); return q; },
    in(f: string, vs: unknown[]) { filters.push((r: any) => vs.includes(r[f])); return q; },
    order(f: string, opts?: { ascending?: boolean }) { sortField = f; sortAsc = opts?.ascending ?? true; return q; },
    limit(n: number) { limitCount = n; return q; },
    range(from: number, to: number) { rangeStart = from; limitCount = to - from + 1; return q; },
    single() { single = true; return q; },
    maybeSingle() { maybeSingle = true; return q; },
    insert(p: any) { isInsert = true; insertPayload = p; return q; },
    update(p: any) { isUpdate = true; updatePayload = p; return q; },
    delete() { isDelete = true; return q; },
    then(resolve: any, _reject?: any) { return Promise.resolve(exec()).then(resolve); },

    // Support both thenable and await
    _exec: exec,
  };

  function exec() {
    // INSERT
    if (isInsert) {
      const payloads = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
      const inserted: any[] = [];
      for (const p of payloads) {
        const row = { id: p.id ?? nextId(), ...p, created_at: p.created_at ?? ts(), updated_at: p.updated_at ?? ts() };
        source.push(row);
        inserted.push(row);
      }
      return { data: single || inserted.length === 1 ? (inserted[0] ?? null) : inserted, error: null };
    }

    // UPDATE
    if (isUpdate) {
      let matched = [...source];
      for (const f of filters) matched = matched.filter(f);
      for (const row of matched) { Object.assign(row, updatePayload); row.updated_at = ts(); }
      return {
        data: single ? (matched[0] ?? null) : matched,
        error: matched.length === 0 && single ? { message: 'not found', code: 'PGRST116' } : null,
      };
    }

    // DELETE
    if (isDelete) {
      const deleted: any[] = [];
      for (let i = source.length - 1; i >= 0; i--) {
        let matches = true;
        for (const f of filters) { if (!f(source[i])) { matches = false; break; } }
        if (matches) { deleted.push(source[i]); source.splice(i, 1); }
      }
      return { data: deleted.length === 1 ? deleted[0] : deleted, error: null };
    }

    // SELECT
    let matched = [...source];
    for (const f of filters) matched = matched.filter(f);

    if (matched.length === 0) {
      if (single) return { data: null, error: { message: 'not found', code: 'PGRST116' } };
      if (maybeSingle) return { data: null, error: null };
      return { data: [], error: null };
    }

    if (sortField) {
      matched.sort((a, b) => {
        const av = (a as any)[sortField!];
        const bv = (b as any)[sortField!];
        if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
      });
    }

    if (limitCount !== undefined) matched = matched.slice(rangeStart, rangeStart + limitCount);

    if (single || maybeSingle) {
      return { data: matched[0] ?? null, error: matched.length === 0 && single ? { message: 'not found', code: 'PGRST116' } : null };
    }
    return { data: matched, error: null };
  }

  return q;
}

// ── JWT constants ────────────────────────────────────────────────────

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const VALID_TOKEN = 'Bearer ' + JWT_AAL2;

// ── Auth helpers ─────────────────────────────────────────────────────

function makeAdmin(): AuthUser {
  return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.com', aal: 'aal2', active: true, appRole: 'admin', orgId: 'org-0000-0000-0000-000000000001' };
}

function makeInterviewer(): AuthUser {
  return { id: '22222222-2222-4222-8222-222222222222', email: 'interviewer@example.com', aal: 'aal2', active: true, appRole: 'interviewer', orgId: 'org-0000-0000-0000-000000000001' };
}

function makeViewer(): AuthUser {
  return { id: 'user-view-0000-0000-000000000003', email: 'viewer@example.com', aal: 'aal1', active: true, appRole: 'viewer', orgId: null };
}

// ── App factory ──────────────────────────────────────────────────────

let auditEntries: any[] = [];

function createGovApp(user: AuthUser) {
  _idCounter = 100;
  tables = freshTables();
  mockFromImpl = makeFrom;
  auditEntries = [];

  const app = createApp({
    authDeps: { getUser: mockAuthGetUser(user, JWT_AAL2) },
    auditSinkOverride: async (entry: any) => { auditEntries.push(entry); },
  });

  return { app, auditEntries: () => auditEntries, tables };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GOV-04: Legal Holds', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should create a legal hold (admin only)', async () => {
    const { app } = createGovApp(makeAdmin());

    const res = await request(app)
      .post('/api/dsar/legal-holds')
      .set('Authorization', VALID_TOKEN)
      .send({
        entity_type: 'candidate',
        entity_id: '11111111-1111-4111-8111-111111111111',
        hold_reason: 'Active litigation case #1234',
        hold_source: 'litigation_hold',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.holdReason).toBe('Active litigation case #1234');
    expect(res.body.data.releasedAt == null).toBe(true);
  });

  it('should reject legal hold creation by non-admin', async () => {
    const { app } = createGovApp(makeInterviewer());
    const res = await request(app)
      .post('/api/dsar/legal-holds')
      .set('Authorization', VALID_TOKEN)
      .send({
        entity_type: 'candidate',
        entity_id: '11111111-1111-4111-8111-111111111111',
        hold_reason: 'Test hold',
        hold_source: 'internal_investigation',
      });
    expect(res.status).toBe(403);
  });

  it('should release a legal hold', async () => {
    const { app } = createGovApp(makeAdmin());
    const createRes = await request(app)
      .post('/api/dsar/legal-holds')
      .set('Authorization', VALID_TOKEN)
      .send({
        entity_type: 'candidate',
        entity_id: '11111111-1111-4111-8111-111111111111',
        hold_reason: 'Test hold for release',
        hold_source: 'court_order',
      });
    expect(createRes.status).toBe(201);
    const holdId = createRes.body.data.id;

    const releaseRes = await request(app)
      .post(`/api/dsar/legal-holds/${holdId}/release`)
      .set('Authorization', VALID_TOKEN)
      .send({ release_reason: 'Case resolved' });

    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body.data.releasedAt).not.toBeNull();
  });

  it('should block erasure when legal hold is active', async () => {
    const { app } = createGovApp(makeAdmin());
    // Create legal hold
    await request(app)
      .post('/api/dsar/legal-holds')
      .set('Authorization', VALID_TOKEN)
      .send({
        entity_type: 'candidate',
        entity_id: '11111111-1111-4111-8111-111111111111',
        hold_reason: 'Active litigation',
        hold_source: 'litigation_hold',
      });

    const dsarRes = await request(app)
      .post('/api/dsar')
      .set('Authorization', VALID_TOKEN)
      .send({
        candidate_id: '11111111-1111-4111-8111-111111111111',
        request_type: 'delete',
      });
    expect(dsarRes.status).toBe(201);
    const dsarId = dsarRes.body.data.id;

    const deleteRes = await request(app)
      .post(`/api/dsar/${dsarId}/delete`)
      .set('Authorization', VALID_TOKEN);

    expect(deleteRes.status).toBe(409);
    expect(deleteRes.body.error.type).toBe('conflict');
    expect(deleteRes.body.error.holds.length).toBeGreaterThanOrEqual(1);
  });

  it('should check legal hold status for an entity', async () => {
    const { app } = createGovApp(makeAdmin());
    await request(app)
      .post('/api/dsar/legal-holds')
      .set('Authorization', VALID_TOKEN)
      .send({
        entity_type: 'candidate',
        entity_id: '11111111-1111-4111-8111-111111111111',
        hold_reason: 'Investigation Q3',
        hold_source: 'internal_investigation',
      });

    const checkRes = await request(app)
      .get('/api/dsar/legal-holds/check?entity_type=candidate&entity_id=11111111-1111-4111-8111-111111111111')
      .set('Authorization', VALID_TOKEN);

    expect(checkRes.status).toBe(200);
    expect(checkRes.body.data.under_legal_hold).toBe(true);
  });

  it('should report no holds when none exist', async () => {
    const { app } = createGovApp(makeAdmin());
    const checkRes = await request(app)
      .get('/api/dsar/legal-holds/check?entity_type=candidate&entity_id=11111111-1111-4111-8111-111111111111')
      .set('Authorization', VALID_TOKEN);
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.data.under_legal_hold).toBe(false);
  });
});

describe('GOV-05: DSAR — Create and Status', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should create a DSAR export request', async () => {
    const { app } = createGovApp(makeInterviewer());
    const res = await request(app)
      .post('/api/dsar')
      .set('Authorization', VALID_TOKEN)
      .send({
        candidate_id: '11111111-1111-4111-8111-111111111111',
        request_type: 'export',
        notes: 'Candidate requested data export',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.requestType).toBe('export');
    expect(res.body.data.requestStatus).toBe('pending');
  });

  it('should create a DSAR delete request', async () => {
    const { app } = createGovApp(makeInterviewer());
    const res = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'delete',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.requestType).toBe('delete');
  });

  it('should create a DSAR correct request', async () => {
    const { app } = createGovApp(makeInterviewer());
    const res = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'correct',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.requestType).toBe('correct');
  });

  it('should get DSAR status by ID', async () => {
    const { app } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'export',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;
    const getRes = await request(app).get(`/api/dsar/${dsarId}`).set('Authorization', VALID_TOKEN);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe(dsarId);
  });

  it('should list DSARs for a candidate', async () => {
    const { app } = createGovApp(makeInterviewer());
    await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'export',
    });
    await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'delete',
    });
    const listRes = await request(app)
      .get('/api/dsar/candidate/11111111-1111-4111-8111-111111111111')
      .set('Authorization', VALID_TOKEN);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(2);
  });

  it('should fulfill a DSAR request', async () => {
    const { app } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'export',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;
    const fulfillRes = await request(app).post(`/api/dsar/${dsarId}/fulfill`).set('Authorization', VALID_TOKEN).send({ status: 'fulfilled' });
    expect(fulfillRes.status).toBe(200);
    expect(fulfillRes.body.data.requestStatus).toBe('fulfilled');
  });

  it('should reject a DSAR request with reason', async () => {
    const { app } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'export',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;
    const rejectRes = await request(app).post(`/api/dsar/${dsarId}/fulfill`).set('Authorization', VALID_TOKEN).send({ status: 'rejected', rejection_reason: 'Insufficient identification' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.requestStatus).toBe('rejected');
  });
});

describe('GOV-05: DSAR Export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should export candidate data with recording consent', async () => {
    const { app } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'export',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;

    const exportRes = await request(app).post(`/api/dsar/${dsarId}/export`).set('Authorization', VALID_TOKEN);
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.data.candidate.name).toBe('Alice Applicant');
    expect(exportRes.body.data.recordingDataIncluded).toBe(true);
  });

  it('should NOT include recording data for job_application consent only', async () => {
    const { app } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '33333333-3333-4333-8333-333333333333', request_type: 'export',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;

    const exportRes = await request(app).post(`/api/dsar/${dsarId}/export`).set('Authorization', VALID_TOKEN);
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.data.recordingDataIncluded).toBe(false);
    expect(exportRes.body.data.recordings.length).toBe(0);
  });
});

describe('GOV-05: DSAR Delete (Erasure)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should delete candidate data when no legal hold exists', async () => {
    const { app } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '33333333-3333-4333-8333-333333333333', request_type: 'delete',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;

    const deleteRes = await request(app).post(`/api/dsar/${dsarId}/delete`).set('Authorization', VALID_TOKEN);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.success).toBe(true);
  });

  it('should block deletion when legal hold is active', async () => {
    const { app } = createGovApp(makeAdmin());
    await request(app).post('/api/dsar/legal-holds').set('Authorization', VALID_TOKEN).send({
      entity_type: 'candidate',
      entity_id: '11111111-1111-4111-8111-111111111111',
      hold_reason: 'Regulatory investigation',
      hold_source: 'regulatory',
    });
    const dsarRes = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'delete',
    });
    expect(dsarRes.status).toBe(201);
    const dsarId = dsarRes.body.data.id;

    const deleteRes = await request(app).post(`/api/dsar/${dsarId}/delete`).set('Authorization', VALID_TOKEN);
    expect(deleteRes.status).toBe(409);
    expect(deleteRes.body.error.holds.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GOV-05: DSAR Correct (Rectification)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should apply corrections to candidate data', async () => {
    const { app, tables } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'correct',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;

    const correctRes = await request(app)
      .post(`/api/dsar/${dsarId}/correct`)
      .set('Authorization', VALID_TOKEN)
      .send({ corrections: [
        { field: 'name', value: 'Alice A. Applicant' },
        { field: 'skills', value: ['JavaScript', 'Python', 'Go'] },
      ] });
    expect(correctRes.status).toBe(200);
    expect(correctRes.body.data.success).toBe(true);
    expect(correctRes.body.data.corrections.length).toBe(2);

    const alice = tables.candidates.find((c: any) => c.id === '11111111-1111-4111-8111-111111111111');
    expect(alice?.name).toBe('Alice A. Applicant');
  });

  it('should reject corrections to governance/audit fields', async () => {
    const { app } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'correct',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;

    const correctRes = await request(app)
      .post(`/api/dsar/${dsarId}/correct`)
      .set('Authorization', VALID_TOKEN)
      .send({ corrections: [
        { field: 'id', value: 'new-id' },
        { field: 'created_at', value: '2020-01-01' },
        { field: 'consent_source', value: 'forged_consent' },
        { field: 'name', value: 'Valid Name' },
      ] });
    expect(correctRes.status).toBe(200);
    expect(correctRes.body.data.corrections.length).toBe(1);
    expect(correctRes.body.data.corrections[0].field).toBe('name');
  });
});

describe('GOV-10: Governance Audit Trail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should record audit entries for governance actions', async () => {
    const { app, auditEntries } = createGovApp(makeAdmin());
    await request(app).post('/api/dsar/legal-holds').set('Authorization', VALID_TOKEN).send({
      entity_type: 'candidate', entity_id: '11111111-1111-4111-8111-111111111111',
      hold_reason: 'Audit test', hold_source: 'court_order',
    });
    const entries = auditEntries();
    const govAudit = entries.filter((e: any) => e.event === 'resource.create' && e.metadata?.hold_id);
    expect(govAudit.length).toBeGreaterThanOrEqual(1);
  });

  it('should track DSAR lifecycle in audit', async () => {
    const { app, auditEntries } = createGovApp(makeInterviewer());
    const createRes = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'export',
    });
    expect(createRes.status).toBe(201);
    const entries = auditEntries();
    const dsarAudit = entries.filter((e: any) => e.event === 'resource.create' && e.metadata?.dsar_id);
    expect(dsarAudit.length).toBeGreaterThanOrEqual(1);
  });
});

describe('D-009: Retain-default does NOT mean no erasure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should allow erasure even when retention policy is indefinite', async () => {
    const { app, tables } = createGovApp(makeInterviewer());
    const candidatePolicy = tables.retentionPolicies.find((p: any) => p.data_category === 'candidate');
    expect(candidatePolicy?.retention_days).toBe(-1);

    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '33333333-3333-4333-8333-333333333333', request_type: 'delete',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;
    const deleteRes = await request(app).post(`/api/dsar/${dsarId}/delete`).set('Authorization', VALID_TOKEN);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.success).toBe(true);
  });
});

describe('Negative: job_application consent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('canAccessRecordingData returns false for job_application consent', async () => {
    const { canAccessRecordingData } = await import('../lib/dsar.js');
    expect(canAccessRecordingData('job_application')).toBe(false);
    expect(canAccessRecordingData(null)).toBe(false);
    expect(canAccessRecordingData('')).toBe(false);
  });

  it('canAccessRecordingData returns true for explicit recording consent', async () => {
    const { canAccessRecordingData } = await import('../lib/dsar.js');
    expect(canAccessRecordingData('recording_consent')).toBe(true);
    expect(canAccessRecordingData('explicit_recording')).toBe(true);
  });
});

describe('Interviewer ownership scoping', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should allow interviewer to create DSAR for owned candidate', async () => {
    const { app } = createGovApp(makeInterviewer());
    const res = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'export',
    });
    expect(res.status).toBe(201);
  });

  it('should reject interviewer DSAR for unowned candidate', async () => {
    const { app, tables } = createGovApp(makeInterviewer());
    const bob = tables.candidates.find((c: any) => c.id === '33333333-3333-4333-8333-333333333333');
    if (bob) bob.owner_id = 'other-interviewer-id';

    const res = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '33333333-3333-4333-8333-333333333333', request_type: 'export',
    });
    expect(res.status).toBe(403);
  });
});

describe('Schema validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setRateLimitStore(new MemoryRateLimitStore());
    setAuditSink(async () => {});
  });

  it('should reject DSAR create with invalid request_type', async () => {
    const { app } = createGovApp(makeInterviewer());
    const res = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'invalid_type',
    });
    expect(res.status).toBe(400);
  });

  it('should reject DSAR fulfill without rejection_reason when rejected', async () => {
    const { app } = createGovApp(makeInterviewer());
    const crate = await request(app).post('/api/dsar').set('Authorization', VALID_TOKEN).send({
      candidate_id: '11111111-1111-4111-8111-111111111111', request_type: 'export',
    });
    expect(crate.status).toBe(201);
    const dsarId = crate.body.data.id;
    const res = await request(app).post(`/api/dsar/${dsarId}/fulfill`).set('Authorization', VALID_TOKEN).send({ status: 'rejected' });
    expect(res.status).toBe(400);
  });

  it('should reject legal hold check without query params', async () => {
    const { app } = createGovApp(makeViewer());
    const res = await request(app).get('/api/dsar/legal-holds/check').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(400);
  });
});
