/**
 * phone-rbac-projection.test.ts — the resume-derived mobile number is
 * admin-only at EVERY projection that can return it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `candidates.phone_e164` / `phone_raw` / `parsed.phone` have been in these
 * responses for a long time, and until 0042 they were always empty, because
 * nothing populated them. The change that fills them does not touch
 * `GET /api/candidates` at all — which is exactly the danger: a route whose
 * diff is unchanged silently starts returning candidate mobile numbers to
 * every viewer and every interviewer on the org. A unit test of
 * `redactCandidatePhone` cannot catch that, because the bug is never "the
 * helper is wrong", it is "a route forgot to call the helper". So every
 * assertion below goes through a real HTTP response via supertest: it is the
 * WIRE BODY that must not contain the number, not a helper's return value.
 *
 * The rule under test (see `lib/candidate-phone.ts`):
 *   - the NUMBER is admin-only, in all of its carriers;
 *   - the FACT of a dialable number (`phone_valid`, a bare boolean) is not
 *     redacted for anyone, because the recruiter UI has to be able to explain
 *     why a candidate is or is not reachable by phone.
 *
 * The carriers are counted deliberately, because "redacted" is not one field:
 * `phone_e164` (nulled, never deleted — both response schemas declare it
 * required), `phone_raw` (deleted outright — no schema requires it), and
 * `parsed.phone` inside the stored structurer blob, which `select('*')`
 * returns and which holds the SAME string as `phone_raw`. Nulling two of the
 * three redacts nothing at all; the number is simply one key further down the
 * same object. Every non-admin case here therefore asserts all three.
 *
 * Only synthetic numbers appear in this file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = 'Bearer ' + JWT;

const admin: AuthUser = {
  id: 'user-admin-0000-0000-000000000001', email: 'admin@example.com',
  aal: 'aal2', active: true, appRole: 'admin', orgId: 'org-0000-0000-0000-000000000001',
};
const interviewer: AuthUser = { ...admin, id: 'user-int-0000-0000-000000000002', appRole: 'interviewer' };
// `viewer` is the widest-reach role on this surface: read-only, org-wide, and
// NOT ownership-scoped, so a viewer sees every candidate row in the org. If
// the number leaks anywhere, it leaks furthest here.
const viewer: AuthUser = { ...admin, id: 'user-view-0000-0000-000000000003', appRole: 'viewer' };

/** The one synthetic Indian mobile used throughout, in its two stored forms. */
const E164 = '+919876543210';
const RAW = '+91 98765-43210';

const mockFrom = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...a: unknown[]) => mockFrom(...a),
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: 'x/y.txt' }, error: null }),
        remove: async () => ({ data: null, error: null }),
      }),
    },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

// The LLM structurer is mocked to return the synthetic number, because the
// PROVENANCE of the extraction is what decides dialability: only a
// model-authored field may become `phone_e164`. Mocking `runClaudeJSON` (not
// the fallback extractor) is what puts the upload on the dialable branch, so
// the 201 body actually has a number in it to redact.
vi.mock('../lib/claude.js', () => ({
  // The literal is repeated rather than referenced: this factory is hoisted
  // above every module-level binding in the file.
  runClaudeJSON: vi.fn().mockResolvedValue({
    name: 'Ada', email: 'ada@example.com', phone: '+91 98765-43210',
    skills: [], experience_years: null, current_role: null, summary: null,
  }),
  runClaudeJSONWithProvenance: vi.fn().mockResolvedValue({
    data: { name: 'Ada', email: 'ada@example.com', phone: '+91 98765-43210', skills: [] },
    requestedModel: 'haiku',
  }),
}));

// DSAR reads are service-layer calls, not table reads, so the seam that
// matters is `lib/dsar.js` itself. The route holds the redaction; the library
// is stubbed to hand it an UNREDACTED payload, which is the only way to prove
// the route is what removes the number rather than the library never having
// produced one.
const getDSAR = vi.fn();
const exportDSAR = vi.fn();
const correctDSAR = vi.fn();
vi.mock('../lib/dsar.js', () => ({
  createDSAR: vi.fn(),
  getDSAR: (...a: unknown[]) => getDSAR(...a),
  listCandidateDSARs: vi.fn(),
  updateDSARStatus: vi.fn(),
  exportDSAR: (...a: unknown[]) => exportDSAR(...a),
  deleteDSAR: vi.fn(),
  correctDSAR: (...a: unknown[]) => correctDSAR(...a),
  // The export route `await import()`s this one lazily for the consent
  // boundary check; omitting it from the mock breaks the route, not the rule.
  canAccessRecordingData: () => false,
}));

function chain(table: string, value: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const methods = ['insert', 'update', 'upsert', 'delete', 'select', 'eq', 'in', 'neq', 'gt', 'gte',
    'lt', 'lte', 'is', 'not', 'order', 'limit', 'range', 'single', 'maybeSingle'];
  for (const m of methods) c[m] = () => chain(table, value);
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

function configure(config: Record<string, unknown>): void {
  mockFrom.mockImplementation((table: string) =>
    chain(table, config[table] ?? { data: null, error: null }));
}

function appFor(user: AuthUser) {
  return createApp({
    nodeEnv: 'test', webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT) },
    auditSinkOverride: async () => {},
  });
}

const ok = (data: unknown) => ({ data, error: null });

const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const DSAR_ID = '33333333-3333-4333-8333-333333333333';

/** The `parsed` structurer blob — the fourth carrier of the same number. */
const PARSED = {
  name: 'Ada', phone: RAW, skills: [], experience_years: null,
  current_role: null, summary: null, email: null,
};

/** The list projection's columns: no `phone_raw`, no `parsed`. */
const LIST_ROW = {
  id: CANDIDATE_ID, name: 'Ada', email: 'ada@example.com',
  phone_e164: E164, phone_valid: true, skills: [], experience_years: null,
  status: 'new', role_id: null, created_at: '2026-08-22T00:00:00Z',
  decision_use_blocked_at: null,
};

/** The `select('*')` row: all three carriers present at once. */
const FULL_ROW = {
  ...LIST_ROW,
  owner_id: interviewer.id,
  consent_source: 'job_application',
  phone_raw: RAW,
  parsed: PARSED,
};

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh limiter per test: `/api/resumes` sits behind the strict bucket and
  // these cases post twice, once per role.
  setRateLimitStore(new MemoryRateLimitStore());
});

/**
 * The whole rule, asserted against one candidate object from a wire body.
 *
 * Factored out because the point of the change is that FOUR code paths share
 * one rule — if this helper only had one call site it would be proving
 * nothing about the paths that were forgotten.
 */
function expectRedactedCandidate(candidate: Record<string, unknown>): void {
  // `phone_raw` is REMOVED, not nulled: no declared schema requires it, and a
  // present-but-null key would invite a future reader to repopulate it.
  expect('phone_raw' in candidate).toBe(false);
  // `phone_e164` is NULLED and the key stays: both response schemas mark it
  // required, so deleting it would trade a privacy break for a contract break.
  expect(candidate.phone_e164).toBeNull();
  expect('phone_e164' in candidate).toBe(true);
  // The carrier that is easiest to forget, and the reason a `select('*')`
  // route cannot be fixed by nulling two columns.
  expect((candidate.parsed as Record<string, unknown>).phone).toBeNull();
  // Not redacted, for anyone: a boolean discloses no contact detail.
  expect(candidate.phone_valid).toBe(true);
}

// ═══════════════════════════════════════════════════════════════════════
// A. GET /api/candidates — the list
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/candidates — phone_e164 is admin-only', () => {
  function seed(): void {
    configure({
      candidates: ok([LIST_ROW]),
      assessments: ok([]),
      ashby_application_links: ok([]),
    });
  }

  it('an admin reads the real number', async () => {
    // The positive control. Without it, a helper that nulled the column for
    // EVERY role would pass every other assertion in this file while quietly
    // breaking the only feature that needs the number.
    seed();
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].phone_e164).toBe(E164);
  });

  it('a viewer gets null — and the key is still THERE', async () => {
    seed();
    const res = await request(appFor(viewer)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    const row = res.body[0];
    expect(row.phone_e164).toBeNull();
    // The OpenAPI list schema marks `phone_e164` required. Dropping the key
    // to hide the value would make the contract untruthful in the other
    // direction and break a typed client that reads the field.
    expect('phone_e164' in row).toBe(true);
  });

  it('an interviewer gets null too — ownership scope is not a privacy control', async () => {
    // An interviewer only sees rows they own, which is an authorization
    // boundary, not a redaction one: owning a candidate record does not make
    // you entitled to dial them.
    seed();
    const res = await request(appFor(interviewer)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].phone_e164).toBeNull();
  });

  it('phone_valid survives for all three roles', async () => {
    // The boolean is the whole reason redaction is a projection and not a
    // narrower `select()`: the UI still has to say "reachable by phone".
    for (const user of [admin, viewer, interviewer]) {
      vi.clearAllMocks();
      seed();
      const res = await request(appFor(user)).get('/api/candidates').set('Authorization', AUTH);
      expect(res.body[0].phone_valid).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. GET /api/candidates/:id — the `select('*')` detail
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/candidates/:id — all three carriers', () => {
  function seed(): void {
    configure({ candidates: ok(FULL_ROW), call_sessions: ok([]), assessments: ok([]) });
  }

  it('an admin keeps phone_raw, phone_e164 AND parsed.phone', async () => {
    seed();
    const res = await request(appFor(admin))
      .get(`/api/candidates/${CANDIDATE_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.candidate.phone_raw).toBe(RAW);
    expect(res.body.candidate.phone_e164).toBe(E164);
    expect(res.body.candidate.parsed.phone).toBe(RAW);
  });

  for (const user of [viewer, interviewer]) {
    it(`a ${user.appRole} gets none of the three`, async () => {
      seed();
      const res = await request(appFor(user))
        .get(`/api/candidates/${CANDIDATE_ID}`).set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expectRedactedCandidate(res.body.candidate);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// C. GET /api/integrations/ashby/review/:applicationLinkId
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/integrations/ashby/review/:id — the second reader of the same row', () => {
  // This route returns the SAME `{candidate, sessions, assessments}` envelope
  // from its own `select('*')`. It is a separate code path, so redacting the
  // candidates route alone would leave the number fully readable through the
  // Ashby review pane — the same disclosure, reached by a different URL.
  function seed(): void {
    configure({
      ashby_application_links: ok({ candidate_id: CANDIDATE_ID }),
      candidates: ok(FULL_ROW),
      call_sessions: ok([]),
      assessments: ok([]),
    });
  }

  it('an admin still sees the number through the review pane', async () => {
    seed();
    const res = await request(appFor(admin))
      .get(`/api/integrations/ashby/review/${LINK_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.candidate.phone_e164).toBe(E164);
    expect(res.body.candidate.parsed.phone).toBe(RAW);
  });

  it('an interviewer gets all three carriers redacted', async () => {
    seed();
    const res = await request(appFor(interviewer))
      .get(`/api/integrations/ashby/review/${LINK_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expectRedactedCandidate(res.body.candidate);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. POST /api/resumes — the 201 that CREATES the number
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/resumes — the upload response', () => {
  // This route's guard admits `admin` AND `interviewer`, so an interviewer can
  // reach a 201 body that was assembled from the value just derived. There are
  // four carriers here, not three: the standalone `{raw,e164,valid}` view is
  // returned alongside the rows.
  function seed(): void {
    configure({
      resumes: ok({ id: 'resume-1', file_name: 'resume.txt', parsed: PARSED }),
      candidates: ok({ ...FULL_ROW, id: 'cand-new' }),
      consent_records: ok(null),
    });
  }

  function upload(user: AuthUser) {
    return request(appFor(user))
      .post('/api/resumes')
      .set('Authorization', AUTH)
      .attach(
        'file',
        Buffer.from('Ada Lovelace, analytical engine engineer, reachable by phone.'),
        'resume.txt',
      );
  }

  it('an admin gets the derived number back in every carrier', async () => {
    seed();
    const res = await upload(admin);
    expect(res.status).toBe(201);
    // Proves the derivation actually produced a dialable number — otherwise
    // the interviewer case below would be asserting nulls against nulls.
    expect(res.body.phone).toEqual({ raw: RAW, e164: E164, valid: true });
    expect(res.body.candidate.phone_raw).toBe(RAW);
    expect(res.body.candidate.phone_e164).toBe(E164);
    expect(res.body.candidate.parsed.phone).toBe(RAW);
  });

  it('an interviewer gets a redacted 201 — including the standalone phone view', async () => {
    seed();
    const res = await upload(interviewer);
    expect(res.status).toBe(201);
    // `null` rather than `''`: a truthful "withheld", where an empty string
    // would read as "the document contained no number".
    expect(res.body.phone.raw).toBeNull();
    expect(res.body.phone.e164).toBeNull();
    // The uploader is still told whether what they just submitted is dialable.
    expect(res.body.phone.valid).toBe(true);
    expectRedactedCandidate(res.body.candidate);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// E. DSAR — the staff-operated export and correction echo
// ═══════════════════════════════════════════════════════════════════════

describe('DSAR responses', () => {
  // DSAR here is STAFF-operated (`requireRole('interviewer')` + ownership),
  // not candidate self-service, so "it is the data subject's own data" does
  // not license the interviewer reading it. The same admin-only rule applies.

  it('POST /api/dsar/:id/export — the candidate payload is nulled below admin', async () => {
    getDSAR.mockResolvedValue({
      id: DSAR_ID, candidateId: CANDIDATE_ID, requestType: 'export',
      requestStatus: 'fulfilled', legalHoldBlocked: false,
    });
    exportDSAR.mockResolvedValue({
      requestId: DSAR_ID,
      candidate: { id: CANDIDATE_ID, name: 'Ada', phone_e164: E164, phone_valid: true },
      sessions: [], assessments: [], transcripts: [], resumes: [], recordings: [],
      recordingDataIncluded: false, exportedAt: '2026-08-22T00:00:00Z',
    });
    configure({ candidates: ok({ owner_id: interviewer.id, consent_source: 'job_application' }) });

    const asInterviewer = await request(appFor(interviewer))
      .post(`/api/dsar/${DSAR_ID}/export`).set('Authorization', AUTH);
    expect(asInterviewer.status).toBe(200);
    expect(asInterviewer.body.data.candidate.phone_e164).toBeNull();

    const asAdmin = await request(appFor(admin))
      .post(`/api/dsar/${DSAR_ID}/export`).set('Authorization', AUTH);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.data.candidate.phone_e164).toBe(E164);
  });

  it('POST /api/dsar/:id/correct — the echoed old/new values are nulled below admin', async () => {
    // The correction echo is a carrier the export payload does not have: it
    // reports the PRIOR value of each field it changed, so a phone correction
    // hands back the number that was there before AND the one written in its
    // place. `phone_raw` is excluded from the export payload upstream, which
    // makes this echo the one place it could still surface.
    getDSAR.mockResolvedValue({
      id: DSAR_ID, candidateId: CANDIDATE_ID, requestType: 'correct',
      requestStatus: 'pending', legalHoldBlocked: false,
    });
    correctDSAR.mockResolvedValue({
      success: true,
      corrections: [
        { field: 'phone_raw', oldValue: RAW, newValue: '+91 90000-00000' },
        { field: 'phone_e164', oldValue: E164, newValue: '+919000000000' },
        { field: 'name', oldValue: 'Ada', newValue: 'Ada Lovelace' },
      ],
    });
    configure({ candidates: ok({ owner_id: interviewer.id, consent_source: 'job_application' }) });

    const body = { corrections: [{ field: 'phone_e164', value: '+919000000000' }] };

    const asInterviewer = await request(appFor(interviewer))
      .post(`/api/dsar/${DSAR_ID}/correct`).set('Authorization', AUTH).send(body);
    expect(asInterviewer.status).toBe(200);
    const byField = Object.fromEntries(
      (asInterviewer.body.data.corrections as Array<{ field: string; oldValue: unknown; newValue: unknown }>)
        .map((c) => [c.field, c]),
    );
    expect(byField.phone_raw.oldValue).toBeNull();
    expect(byField.phone_raw.newValue).toBeNull();
    expect(byField.phone_e164.oldValue).toBeNull();
    expect(byField.phone_e164.newValue).toBeNull();
    // A non-phone correction is untouched: this redaction is field-scoped, and
    // blanking the whole echo would destroy the audit value of the response.
    expect(byField.name.oldValue).toBe('Ada');
    expect(byField.name.newValue).toBe('Ada Lovelace');

    const asAdmin = await request(appFor(admin))
      .post(`/api/dsar/${DSAR_ID}/correct`).set('Authorization', AUTH).send(body);
    expect(asAdmin.status).toBe(200);
    const adminFields = (asAdmin.body.data.corrections as Array<{ field: string; oldValue: unknown }>);
    expect(adminFields.find((c) => c.field === 'phone_e164')?.oldValue).toBe(E164);
    expect(adminFields.find((c) => c.field === 'phone_raw')?.oldValue).toBe(RAW);
  });
});
