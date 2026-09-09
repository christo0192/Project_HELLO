/**
 * The sync recruiter-upload path (POST /api/resumes) used to return an HTTP
 * error and delete the stored file on a parse failure, leaving NO row — so the
 * funnel's "entered the parser" denominator was silently short on that path.
 * 0090 adds a best-effort capture into screening_v2.resume_intake_failures.
 *
 * A capture with no proof it fires is exactly the "table nobody writes" trap,
 * so this drives a real parse failure through the route and asserts BOTH that
 * the response is unchanged (still 422 parse_error) AND that the sanitized
 * failure code was written to resume_intake_failures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Hoisted module mocks — the route uses the module-level supabase client and
// parseResume import directly.
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), storage: { from: vi.fn() } },
  RESUME_BUCKET: 'resumes_v2',
}));

vi.mock('../lib/resume-parser.js', () => ({
  parseResume: vi.fn().mockRejectedValue(
    Object.assign(new Error('unreadable'), { name: 'ParserError', code: 'PARSER_ERROR' }),
  ),
}));

import { createResumesRouter } from '../routes/resumes.js';

/** A Supabase query-builder stand-in that resolves to `value` for any chain. */
function chainable(value: unknown): any {
  const fn: any = () => chainable(value);
  fn.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(value).then(resolve, reject);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  fn.eq = () => chainable(value);
  fn.select = () => chainable(value);
  fn.insert = () => chainable(value);
  fn.single = () => chainable(value);
  return fn;
}

function createSupabaseMock() {
  const storageUpload = vi.fn().mockResolvedValue({ data: { path: 'k' }, error: null });
  const storageRemove = vi.fn().mockResolvedValue({ data: null, error: null });
  return {
    from: vi.fn().mockReturnValue(chainable({ data: null, error: null })),
    storage: { from: vi.fn().mockReturnValue({ upload: storageUpload, remove: storageRemove }) },
  };
}

let supabaseMock: ReturnType<typeof createSupabaseMock>;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  supabaseMock = createSupabaseMock();
  Object.assign(mod.supabase, supabaseMock);
});

function testApp() {
  const router = createResumesRouter({
    authGuard: { name: 'test-permissive', async authorize() { return 'test-recruiter'; } },
    nodeEnv: 'test',
  });
  const app = express();
  app.use('/api/resumes', router);
  return app;
}

describe('sync-upload parse-failure capture (0090)', () => {
  it('records a sanitized code in resume_intake_failures and still returns 422', async () => {
    const res = await request(testApp())
      .post('/api/resumes')
      .attach('file', Buffer.from('A readable plain text resume with more than twenty characters.'), 'resume.txt')
      .field('role_id', '00000000-0000-4000-8000-000000000001')
      .expect(422);

    expect(res.body.error.type).toBe('parse_error');

    const tables = supabaseMock.from.mock.calls.map((c) => c[0]);
    expect(tables).toContain('resume_intake_failures');
  });
});
