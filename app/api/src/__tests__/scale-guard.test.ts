/**
 * Scale guard (M026 root cause 1, fix point 2): the next unbatched read fails
 * here, in CI, and not in production.
 *
 * On 2026-11-04 the workspace passed about 390 candidates and the candidate
 * list and summary lost every score: one `.in()` over every candidate id built
 * a ~16 KB URL, Node's fetch (undici) rejected the echoed header
 * (UND_ERR_HEADERS_OVERFLOW), and the routes read the error as "no data".
 * PostgREST also cuts any response at 1000 rows without an error. Every check
 * the project ran used 26 candidates, so nothing saw either limit.
 *
 * This suite drives every route that reads over a list growing with the
 * workspace, against a workspace of 1,200 and of 5,000 candidates with
 * related rows in proportion (support/scale-workspace.ts), as admin and as
 * interviewer where the scope differs. The supabase double
 * (support/scale-db.ts) fails any `.in()` over ID_BATCH_SIZE (100) values
 * exactly as undici does, and truncates every response at 1000 rows.
 *
 * Each route must answer correctly with complete data, or fail closed with an
 * explicit error. Never silently partial: `expectNoSilentLimit` fails a test
 * whose route sent an oversized `.in()` or had a response cut by the row cap,
 * even when the route itself answered 200.
 *
 * Reads that are NOT driven here, and why:
 *   - per-candidate reads (/:id, phone attempts and cycles, notes, appeals,
 *     Ashby review): bounded by one candidate's history, not the workspace
 *     (the CSV export is the exception below: its transcript can pass 1000 rows);
 *   - client-paged lists (/api/admin/audit, /sessions, /quotas,
 *     /funnel/candidates): each request is one explicit `.range()` page;
 *   - /api/phone/calendar/slots: one IST day, capped at 400 live appointments
 *     with an explicit `occupancy_truncated` flag, and no id-list read;
 *   - /api/roles: grows with roles, not candidates, and already reads its
 *     mappings in batches of 100.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { ID_BATCH_SIZE, POSTGREST_MAX_ROWS } from '../lib/id-batches.js';
import { scaleDb as engine, UNDICI_OVERFLOW_ERROR, type RecordedQuery, type Row } from './support/scale-db.js';
import {
  CALENDAR_FROM, CALENDAR_TO, FAILURES_FROM, FUNNEL_FROM, FUNNEL_TO, SCALE_ADMIN_ID, SCALE_INTERVIEWER_ID,
  scaleIds, scaleIso, seedScaleWorkspace, type ScaleWorkspace,
} from './support/scale-workspace.js';

vi.mock('../lib/supabase.js', async () => {
  const { scaleDb } = await import('./support/scale-db.js');
  return { supabase: scaleDb.client, RESUME_BUCKET: 'resumes_v2' };
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';

const admin: AuthUser = {
  id: SCALE_ADMIN_ID, email: 'admin@example.com', aal: 'aal2', active: true, appRole: 'admin',
  orgId: 'org-0000-0000-0000-000000000001',
};
const interviewer: AuthUser = { ...admin, id: SCALE_INTERVIEWER_ID, email: 'interviewer@example.com', appRole: 'interviewer' };

const SIZES = [1200, 5000] as const;

function appFor(user: AuthUser) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT) },
    auditSinkOverride: async () => {},
  });
}

const get = (path: string, user: AuthUser) =>
  request(appFor(user)).get(path).set('Authorization', `Bearer ${JWT}`).timeout(15_000);

const label = (q: RecordedQuery): string =>
  `${q.table}: ${q.inValues ? `in(${q.inValues.length} values)` : 'no in()'}, matched ${q.matched}, returned ${q.returned}`;

/** The guard: no read went past the id batch size, none was cut by the row cap, the double modelled every call. */
function expectNoSilentLimit(): void {
  expect(engine.unsupported, 'builder methods the test double does not model').toEqual([]);
  expect(engine.overflows().map(label), `reads over more than ${ID_BATCH_SIZE} ids (undici refuses past ~390)`).toEqual([]);
  expect(engine.truncations().map(label), `reads cut at ${POSTGREST_MAX_ROWS} rows with no error`).toEqual([]);
}

beforeEach(() => {
  engine.reset({ overflowAt: ID_BATCH_SIZE });
  vi.stubEnv('PHONE_SCREENING_ENABLED', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The slice of a PostgREST builder the guard's self-checks call. */
interface Chain extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns: string): Chain;
  in(column: string, values: unknown[]): Chain;
  [method: string]: unknown;
}
const from = (table: string): Chain => engine.client.from(table) as Chain;

describe('the guard itself', () => {
  it('refuses an .in() over the batch size exactly as undici does, and records it', async () => {
    engine.tables.candidates = Array.from({ length: ID_BATCH_SIZE + 1 }, (_, i) => ({ id: scaleIds.candidate(i) }));
    const ids = engine.tables.candidates.map((r) => r.id);
    expect(await from('candidates').select('id').in('id', ids)).toMatchObject({ data: null, error: UNDICI_OVERFLOW_ERROR });
    const within = await from('candidates').select('id').in('id', ids.slice(0, ID_BATCH_SIZE));
    expect(within.data).toHaveLength(ID_BATCH_SIZE);
    expect(engine.overflows()).toHaveLength(1);
  });

  it('cuts a long response at 1000 rows with no error, and records the cut', async () => {
    engine.tables.candidates = Array.from({ length: POSTGREST_MAX_ROWS + 1 }, (_, i) => ({ id: scaleIds.candidate(i) }));
    const res = await from('candidates').select('id');
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(POSTGREST_MAX_ROWS);
    expect(engine.truncations()).toHaveLength(1);
  });

  it('records a builder method it does not model instead of ignoring it', () => {
    const q = from('candidates').select('id');
    expect(() => (q.textSearch as () => void)()).toThrow(/not modelled/);
    expect(engine.unsupported).toEqual(['candidates.textSearch']);
  });
});

describe.each(SIZES)('a workspace of %i candidates', (n) => {
  let ws: ScaleWorkspace;
  beforeEach(() => {
    ws = seedScaleWorkspace(engine.tables, n);
  });

  describe('GET /api/candidates', () => {
    it('as admin: every candidate, with every score, resume state and dial count', async () => {
      const res = await get('/api/candidates', admin);
      expect(res.status).toBe(200);
      const body = res.body as Row[];
      expect(body).toHaveLength(n);
      expect(new Set(body.map((c) => c.id)).size).toBe(n);
      const scored = body.filter((c) => c.latest_score != null);
      expect(scored).toHaveLength(ws.latest.size);
      for (const c of scored) {
        const want = ws.latest.get(c.id as string)!;
        expect({ score: c.latest_score, recommendation: c.latest_recommendation }).toEqual(want);
      }
      expect(body.every((c) => c.resume_review === 'ready' && c.intake_type === 'resume_parsing')).toBe(true);
      expect(body.every((c) => c.ashby_job_status === 'enabled')).toBe(true);
      expect(body.every((c) => c.dial_count === 1)).toBe(true);
      expectNoSilentLimit();
    });

    it('as interviewer: exactly the candidates they own, complete', async () => {
      const res = await get('/api/candidates', interviewer);
      expect(res.status).toBe(200);
      const body = res.body as Row[];
      expect(body).toHaveLength(ws.owned.size);
      expect(body.every((c) => ws.owned.has(c.id as string))).toBe(true);
      const ownedScored = [...ws.latest.keys()].filter((id) => ws.owned.has(id));
      expect(body.filter((c) => c.latest_score != null)).toHaveLength(ownedScored.length);
      expect(body.every((c) => c.dial_count === 1 && c.resume_review === 'ready')).toBe(true);
      expectNoSilentLimit();
    });
  });

  describe('GET /api/candidates/summary', () => {
    const expected = (ids: string[]) => {
      const dist = { advance: 0, hold: 0, reject: 0 } as Record<string, number>;
      let sum = 0;
      for (const id of ids) { const l = ws.latest.get(id)!; dist[l.recommendation] += 1; sum += l.score; }
      return { assessed_count: ids.length, average_score: Math.round((sum / ids.length) * 10) / 10, recommendation_distribution: dist };
    };

    it('as admin: counts every assessed candidate', async () => {
      const res = await get('/api/candidates/summary', admin);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected([...ws.latest.keys()]));
      expectNoSilentLimit();
    });

    it('as interviewer: counts every assessed candidate they own', async () => {
      const res = await get('/api/candidates/summary', interviewer);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected([...ws.latest.keys()].filter((id) => ws.owned.has(id))));
      expectNoSilentLimit();
    });
  });

  describe('GET /api/notifications', () => {
    it('as admin: the newest 100 intents of the workspace, newest first', async () => {
      const res = await get('/api/notifications', admin);
      expect(res.status).toBe(200);
      expect((res.body.intents as Row[]).map((i) => i.id)).toEqual(ws.intentsNewestFirst.slice(0, 100).map((i) => i.id));
      expectNoSilentLimit();
    });

    it('as interviewer: the newest 100 intents across EVERY candidate they own, newest first', async () => {
      const res = await get('/api/notifications', interviewer);
      expect(res.status).toBe(200);
      const want = ws.intentsNewestFirst.filter((i) => ws.owned.has(i.candidate_id)).slice(0, 100);
      expect((res.body.intents as Row[]).map((i) => i.id)).toEqual(want.map((i) => i.id));
      expectNoSilentLimit();
    });

    it('as interviewer: fails the request, never a partial list, when one batch of intents fails', async () => {
      const oldest = scaleIds.candidate(0);
      engine.failWhen = (q) => q.table === 'notification_intents' && (q.inValues ?? []).includes(oldest);
      const res = await get('/api/notifications', interviewer);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body.intents).toBeUndefined();
    });
  });

  describe('GET the funnel summary over a year', () => {
    const query = `?from=${FUNNEL_FROM}&to=${FUNNEL_TO}`;

    it.each([
      ['/api/funnel/summary', 'interviewer'],
      ['/api/admin/funnel/summary', 'admin'],
    ] as const)('%s as %s: totals over every rollup row in the window', async (path, who) => {
      const res = await get(`${path}${query}`, who === 'admin' ? admin : interviewer);
      expect(res.status).toBe(200);
      expect(res.body.totals.entered_parse).toBe(n);
      expect(res.body.totals.candidates_total).toBe(n);
      expect(res.body.series).toHaveLength(Math.min(n, 365));
      expect(res.body.meta.hr_tracking_configured).toBe(true);
      expectNoSilentLimit();
    });
  });

  describe('GET /api/admin/funnel/failures', () => {
    it('counts every failure in the window, or says plainly that it counted only the newest 1000', async () => {
      const res = await get(`/api/admin/funnel/failures?from=${FAILURES_FROM}&to=${FUNNEL_TO}`, admin);
      expect(res.status).toBe(200);
      const counted = (res.body.groups as Array<{ count: number }>).reduce((a, g) => a + g.count, 0);
      if (ws.failures >= POSTGREST_MAX_ROWS) {
        expect(res.body.truncated).toBe(true);
        expect(counted).toBe(POSTGREST_MAX_ROWS);
      } else {
        expect(res.body.truncated).toBe(false);
        expect(counted).toBe(ws.failures);
      }
      expectNoSilentLimit();
    });
  });

  describe('GET Ashby Mission Control lists (largest page)', () => {
    it('workflows: every row of the page has its session status and evidence hold', async () => {
      const res = await get('/api/integrations/ashby/mission-control/workflows?limit=200', interviewer);
      expect(res.status).toBe(200);
      const rows = res.body.workflows as Row[];
      expect(rows).toHaveLength(200);
      for (const row of rows) {
        const i = Number(String(row.applicationLinkId).slice(-12));
        expect(row.sessionStatus, `link ${i}`).toBe(i % 3 === 0 ? 'completed' : 'expired');
        expect(row.heldForEvidence, `link ${i}`).toBe(ws.heldForEvidence(i));
      }
      expectNoSilentLimit();
    });

    it('mappings: the newest live mappings, up to the page size', async () => {
      const res = await get('/api/integrations/ashby/mission-control/mappings?limit=200', interviewer);
      expect(res.status).toBe(200);
      expect(res.body.mappings).toHaveLength(Math.min(ws.mappings, 200));
      expectNoSilentLimit();
    });
  });

  describe('GET /api/phone/calendar (30 days)', () => {
    it('every appointment shown carries its engagement and candidate, and a cut list says so', async () => {
      const res = await get(`/api/phone/calendar?from=${CALENDAR_FROM}&to=${CALENDAR_TO}`, interviewer);
      expect(res.status).toBe(200);
      const shown = Math.min(ws.appointments, 200);
      expect(res.body.count).toBe(shown);
      expect(res.body.truncated).toBe(ws.appointments > 200);
      for (const a of res.body.appointments as Array<Row & { candidate: Row | null }>) {
        const i = Number(String(a.id).slice(-12));
        expect(a.engagement_state, `appointment ${i}`).toBe('completed');
        expect(a.candidate?.id, `appointment ${i}`).toBe(scaleIds.candidate(i));
      }
      expectNoSilentLimit();
    });
  });
});

describe('GET Mission Control workflows when an evidence read reaches the row cap', () => {
  it('reports every hold as unreadable (null), never as "not held", and keeps the list', async () => {
    seedScaleWorkspace(engine.tables, 1200);
    // Link 1199 is on the newest page and parked; give its session 1000 rescores.
    for (let k = 0; k < POSTGREST_MAX_ROWS; k += 1) {
      engine.tables.assessments.push({
        id: `ac000000-0000-4000-8000-${String(k).padStart(12, '0')}`, candidate_id: scaleIds.candidate(1199),
        session_id: scaleIds.session(1199), overall_score: 50, recommendation: 'hold', evidence_grade: 'decision',
        created_at: scaleIso(1199, k), source: 'phone',
      });
    }
    const res = await get('/api/integrations/ashby/mission-control/workflows?limit=200', interviewer);
    expect(res.status).toBe(200);
    const rows = res.body.workflows as Row[];
    expect(rows).toHaveLength(200);
    for (const row of rows) {
      const i = Number(String(row.applicationLinkId).slice(-12));
      // Only parked links are examined; a link that is not parked is not held.
      expect(row.heldForEvidence, `link ${i}`).toBe(i % 4 === 0 ? false : null);
      expect(typeof row.sessionStatus, `link ${i}`).toBe('string');
    }
    expect(engine.overflows()).toEqual([]);
  });
});

describe('GET /api/export/:candidateId/csv for a candidate with a long history', () => {
  // Fifteen screening sessions of 80 turns: 1,200 transcript rows, past the row cap.
  const SESSIONS = 15;
  const TURNS = 80;
  const candidate = scaleIds.candidate(7);

  beforeEach(() => {
    engine.tables.candidates = [{ id: candidate, owner_id: SCALE_INTERVIEWER_ID, status: 'screened' }];
    engine.tables.assessments = [];
    engine.tables.call_sessions = [];
    engine.tables.transcript_turns = [];
    for (let s = 0; s < SESSIONS; s += 1) {
      const session = scaleIds.session(s);
      engine.tables.call_sessions.push({ id: session, candidate_id: candidate, created_at: scaleIso(s) });
      engine.tables.assessments.push({
        id: scaleIds.assessment(s), candidate_id: candidate, session_id: session, overall_score: 50 + s,
        recommendation: 'hold', created_at: scaleIso(s, 30), schema_version: 1,
      });
      // Stored newest turn first, so storage order cannot stand in for the read's ORDER BY.
      for (let k = TURNS - 1; k >= 0; k -= 1) {
        engine.tables.transcript_turns.push({
          session_id: session, turn_index: k, speaker: k % 2 === 0 ? 'bot' : 'candidate', text: `s${s} t${k}`, created_at: scaleIso(s, k),
        });
      }
    }
  });

  const rowsOf = (csv: string, type: string) => csv.split('\r\n').filter((l) => l.startsWith(`${type},`));

  it.each([['admin', admin], ['the owning interviewer', interviewer]] as const)('as %s: every scorecard and every transcript turn, in order', async (_who, user) => {
    const res = await get(`/api/export/${candidate}/csv`, user);
    expect(res.status).toBe(200);
    expect(rowsOf(res.text, 'scorecard')).toHaveLength(SESSIONS);
    const turns = rowsOf(res.text, 'transcript');
    expect(turns).toHaveLength(SESSIONS * TURNS);
    // Session order, then turn order: the first session's turns 0..79 come first.
    expect(turns[0]).toContain('s0 t0');
    expect(turns[TURNS - 1]).toContain(`s0 t${TURNS - 1}`);
    expect(turns.at(-1)).toContain(`s${SESSIONS - 1} t${TURNS - 1}`);
    expectNoSilentLimit();
  });

  it('fails the export, rather than sending a CSV without its transcript, when a transcript read fails', async () => {
    engine.failWhen = (q) => q.table === 'transcript_turns';
    const res = await get(`/api/export/${candidate}/csv`, admin);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.text).not.toContain('scorecard,');
  });

  it('fails the export when the scorecard read fails', async () => {
    engine.failWhen = (q) => q.table === 'assessments';
    const res = await get(`/api/export/${candidate}/csv`, admin);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
