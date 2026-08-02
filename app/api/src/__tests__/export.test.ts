/**
 * Phase 9 L3 — /api/export (invariant 6) + lib/export-csv.
 * Authenticated GET, ownership scope, scorecard data minimization, RFC4180
 * quoting, UTF-8 BOM, fixed UUID-derived filename, formula-injection
 * neutralization (including leading whitespace/TAB/CR), non-Latin preserved.
 * No PDF claim.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { exportRouter } from '../routes/export.js';
import {
  csvEscape,
  neutralizeFormulaCell,
  toCsv,
  csvFilename,
  CSV_BOM,
} from '../lib/export-csv.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
const RECRUITER_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_RECRUITER_ID = '00000000-0000-4000-8000-0000000000ee';

let inserted: any[] = [];

function chainable(value: any): any {
  const fn = function () { return chainable(value); };
  fn.then = (resolve: (v: any) => any) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  fn.eq = () => chainable(value);
  fn.order = () => chainable(value);
  fn.limit = () => chainable(value);
  fn.select = () => chainable(value);
  fn.maybeSingle = () => chainable(value);
  fn.single = () => chainable(value);
  fn.is = () => chainable(value);
  fn.in = () => chainable(value);
  fn.range = () => chainable(value);
  fn.insert = (...args: any[]) => { inserted.push(args); return chainable(value); };
  fn.update = () => chainable(value);
  return fn;
}

function makeUser(role: AuthUser['appRole'], overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: RECRUITER_ID,
    email: 'recruiter@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
    ...overrides,
  };
}

let mockFrom: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockFrom.mockReset();
  inserted = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT_AAL2) }));
  app.use('/api/export', exportRouter);
  app.use(finalErrorHandler);
  return app;
}

const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };

const ASSESSMENT_ROW = {
  id: '00000000-0000-4000-8000-0000000000d1',
  english: { band: 'B2', grammar: 7, vocabulary: 8, fluency: 7, coherence: 8 },
  tone: { clarity: 8, confidence: 7, professionalism: 9 },
  communication: { score: 7.5, clarity: 7 },
  motivation: { score: 8 },
  role_fit: { score: 6 },
  overall_score: 76,
  recommendation: 'advance',
  created_at: '2025-01-01T00:00:00.000Z',
};

describe('GET /api/export/:candidateId/csv — auth/ownership', () => {
  it('401 without auth', async () => {
    const res = await request(makeApp(makeUser('admin'))).get(`/api/export/${CANDIDATE_ID}/csv`);
    expect(res.status).toBe(401);
  });

  it('viewer is not an exporter → 403', async () => {
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .get(`/api/export/${CANDIDATE_ID}/csv`)
      .set(AUTH);
    expect(res.status).toBe(403);
  });

  it('non-owner interviewer denied (403)', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: { owner_id: OTHER_RECRUITER_ID, status: 'screened' }, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/export/${CANDIDATE_ID}/csv`)
      .set(AUTH);
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalledWith('assessments');
  });

  it('unknown candidate → 404', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/export/${CANDIDATE_ID}/csv`)
      .set(AUTH);
    expect(res.status).toBe(404);
  });

  it('400 non-UUID path param', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .get('/api/export/not-a-uuid/csv')
      .set(AUTH);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/export/:candidateId/csv — content contract', () => {
  it('owner interviewer → 200 CSV with BOM, RFC4180, fixed filename, audit', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { owner_id: RECRUITER_ID, status: 'screened' }, error: null }))
      .mockReturnValueOnce(chainable({ data: [ASSESSMENT_ROW], error: null }))
      .mockReturnValueOnce(chainable({ data: [{ id: '00000000-0000-4000-8000-0000000000aa', created_at: '2025-01-01T00:00:00.000Z' }], error: null }))
      .mockReturnValueOnce(
        chainable({
          data: [
            { session_id: '00000000-0000-4000-8000-0000000000aa', turn_index: 0, speaker: 'bot', text: 'Welcome to the screening.', created_at: '2025-01-01T00:00:00.000Z' },
            { session_id: '00000000-0000-4000-8000-0000000000aa', turn_index: 1, speaker: 'candidate', text: 'Thanks!', created_at: '2025-01-01T00:00:01.000Z' },
          ],
          error: null,
        }),
      )
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/export/${CANDIDATE_ID}/csv`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-type']).toContain('charset=utf-8');
    expect(res.headers['content-disposition']).toContain(
      `attachment; filename="screening-export-${CANDIDATE_ID}.csv"`,
    );
    expect(res.text.startsWith(CSV_BOM)).toBe(true);
    // Header row present with the record_type discriminator.
    expect(res.text).toContain(
      'record_type,candidate_id,candidate_status,session_id,assessment_id,turn_index,speaker,transcript_text,english,tone,communication,motivation,role_fit,overall_score,recommendation,created_at',
    );
    // Scorecard row present.
    expect(res.text).toContain('scorecard');
    expect(res.text).toContain('advance');
    // Transcript rows present with speaker + text.
    expect(res.text).toContain('transcript');
    expect(res.text).toContain('Welcome to the screening.');
    expect(res.text).toContain('Thanks!');
    // No PII/raw/recording columns.
    expect(res.text).not.toContain('email');
    expect(res.text).not.toContain('phone');
    expect(res.text).not.toContain('resume');
    expect(res.text).not.toContain('recording');
    expect(res.text).not.toContain('raw');
    expect(res.text).not.toContain('model');
    // Best-effort export audit row written.
    expect(inserted.some((a) => JSON.stringify(a).includes('export_completed'))).toBe(true);
  });

  it('admin can export any candidate (including empty transcript/assessment)', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { owner_id: OTHER_RECRUITER_ID, status: 'rejected' }, error: null }))
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('admin')))
      .get(`/api/export/${CANDIDATE_ID}/csv`)
      .set(AUTH);
    expect(res.status).toBe(200);
    // Empty candidate → header-only CSV (no fabricated rows).
    expect(res.text.startsWith(CSV_BOM)).toBe(true);
    expect(res.text).toContain('record_type,candidate_id');
    // No data rows at all: no scorecard/transcript record_type values.
    expect(res.text.match(/^scorecard,/gm)).toBeNull();
    expect(res.text.match(/^transcript,/gm)).toBeNull();
    const lines = res.text.replace(CSV_BOM, '').split('\r\n');
    expect(lines.filter((l) => l.length > 0)).toHaveLength(1); // header only
  });

  it('formula payloads in transcript text AND scorecard fields are neutralized', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { owner_id: RECRUITER_ID, status: '=HYPERLINK("http://evil")' }, error: null }))
      .mockReturnValueOnce(chainable({ data: [{ ...ASSESSMENT_ROW, recommendation: '=cmd|' }], error: null }))
      .mockReturnValueOnce(chainable({ data: [{ id: '00000000-0000-4000-8000-0000000000aa', created_at: '2025-01-01T00:00:00.000Z' }], error: null }))
      .mockReturnValueOnce(
        chainable({
          data: [
            { session_id: '00000000-0000-4000-8000-0000000000aa', turn_index: 0, speaker: 'bot', text: '  =HYPERLINK("http://evil")', created_at: '2025-01-01T00:00:00.000Z' },
            { session_id: '00000000-0000-4000-8000-0000000000aa', turn_index: 1, speaker: 'candidate', text: '\t+cmd', created_at: '2025-01-01T00:00:01.000Z' },
          ],
          error: null,
        }),
      )
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/export/${CANDIDATE_ID}/csv`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.text).toContain("'=HYPERLINK");
    expect(res.text).toContain("'=cmd");
    // Leading-whitespace formula payload neutralized (apostrophe prefix).
    expect(res.text).toContain("'  =HYPERLINK");
    expect(res.text).toContain("'	+cmd");
  });

  it('non-Latin transcript text survives with the BOM (byte-level fidelity)', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { owner_id: RECRUITER_ID, status: 'screened' }, error: null }))
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: [{ id: '00000000-0000-4000-8000-0000000000aa', created_at: '2025-01-01T00:00:00.000Z' }], error: null }))
      .mockReturnValueOnce(
        chainable({
          data: [
            { session_id: '00000000-0000-4000-8000-0000000000aa', turn_index: 0, speaker: 'candidate', text: 'मैं हिन्दी बोलता हूँ और 日本語も話せます', created_at: '2025-01-01T00:00:00.000Z' },
          ],
          error: null,
        }),
      )
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/export/${CANDIDATE_ID}/csv`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.text.startsWith(CSV_BOM)).toBe(true);
    expect(res.text).toContain('मैं हिन्दी बोलता हूँ');
    expect(res.text).toContain('日本語も話せます');
    const roundTrip = Buffer.from(res.text, 'utf-8').toString('utf-8');
    expect(roundTrip).toBe(res.text);
  });
});

describe('lib/export-csv — formula injection neutralization', () => {
  it('prefixes = + - @ TAB CR and leading-whitespace variants with apostrophe', () => {
    expect(csvEscape('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvEscape('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvEscape('-2+3')).toBe("'-2+3");
    expect(csvEscape('@import')).toBe("'@import");
    expect(csvEscape('\t=1+1')).toBe("'\t=1+1");
    // CR is both a formula trigger AND an RFC4180 quoting trigger: the
    // apostrophe prefix is applied, then the cell is quoted.
    expect(csvEscape('\r=2')).toBe("\"'\r=2\"");
    expect(csvEscape('  =1+1')).toBe("'  =1+1");
    expect(csvEscape('   @cmd')).toBe("'   @cmd");
  });

  it('leaves ordinary text and numeric-safe cells untouched', () => {
    expect(csvEscape('safe text')).toBe('safe text');
    expect(csvEscape('007')).toBe('007');
    expect(csvEscape('a+b')).toBe('a+b');
    expect(csvEscape('')).toBe('');
  });

  it('neutralizeFormulaCell keeps the original cell intact (leading whitespace preserved)', () => {
    expect(neutralizeFormulaCell(' \t=1')).toBe("' \t=1");
    expect(neutralizeFormulaCell('plain')).toBe('plain');
  });
});

describe('lib/export-csv — RFC4180 quoting', () => {
  it('quotes fields with comma/quote/CRLF and doubles embedded quotes', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('serializes CRLF rows with a header row', () => {
    const csv = toCsv(
      [{ name: 'Alice', score: 8 }, { name: 'Bob, Jr.', score: '=1+1' }],
      ['name', 'score'],
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('name,score');
    expect(lines[1]).toBe('Alice,8');
    expect(lines[2]).toBe('"Bob, Jr.",\'=1+1');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('lib/export-csv — non-Latin preservation', () => {
  it('Hindi/Japanese synthetic text round-trips in UTF-8', () => {
    const hindi = 'हिन्दी परीक्षण';
    const japanese = '日本語テスト';
    const csv = CSV_BOM + toCsv([{ note: `${hindi} ${japanese}` }], ['note']);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toContain(hindi);
    expect(csv).toContain(japanese);
    // Round-trip through Buffer UTF-8 to prove byte-level fidelity.
    const roundTrip = Buffer.from(csv, 'utf-8').toString('utf-8');
    expect(roundTrip).toBe(csv);
  });
});

describe('lib/export-csv — safe filename', () => {
  it('filename is fixed and UUID-derived (malicious filenames impossible)', () => {
    // The route validates candidateId with uuidSchema BEFORE calling
    // csvFilename (non-UUID → 400, covered above), so only UUIDs reach it.
    // The name truthfully reflects scorecard + transcript content.
    expect(csvFilename(CANDIDATE_ID)).toBe(`screening-export-${CANDIDATE_ID}.csv`);
    expect(/^screening-export-[0-9a-f-]{36}\.csv$/.test(csvFilename(CANDIDATE_ID))).toBe(true);
  });
});
