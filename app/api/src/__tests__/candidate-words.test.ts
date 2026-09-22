/**
 * `candidate_words` on GET /api/candidates/:id — the count itself.
 *
 * WHY THIS FILE EXISTS. Every web test injects `candidate_words` straight into
 * a mocked payload, so the pagination loop, the has-a-transcript set and the
 * unusable bail-out were exercised by nothing at all. If the query broke, the
 * count would be `null` for every candidate, the badge would silently vanish,
 * and no test and no log would say so.
 *
 * The figure matters because `duration_sec` is wall clock — bot speech,
 * candidate speech, ring and silence — and reads as engagement when it is not.
 * Praveetha's 2026-09-10 screen had 8 of 8 bot turns barged-in and truncated
 * and a perfectly healthy-looking wall clock. Words the candidate actually
 * said is the figure that separates that call from a good one, so it is worth
 * being right, and worth being ABSENT rather than wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const { candidatesRouter } = await import('../routes/candidates.js');
const { supabase } = await import('../lib/supabase.js');

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };
const USER = '00000000-0000-4000-8000-0000000000ff';
const CANDIDATE = '00000000-0000-4000-8000-000000000001';
const S1 = '00000000-0000-4000-8000-00000000aaa1';
const S2 = '00000000-0000-4000-8000-00000000aaa2';

/** One transcript turn as the table stores it. */
const turn = (session_id: string, speaker: string, text: string | null) => ({
  session_id,
  speaker,
  text,
});

interface Scenario {
  sessions: Array<Record<string, unknown>>;
  /** Pages the turn query returns, in order. */
  turnPages: Array<Array<ReturnType<typeof turn>>>;
  turnError?: unknown;
}
let scenario: Scenario;
/** Every `.range(from, to)` the turn query asked for. */
let ranges: Array<[number, number]>;
/**
 * OUTSIDE `chain`, deliberately. The route calls `supabase.from(...)` fresh on
 * every pass of the pagination loop, so a counter living inside the builder
 * resets each time and hands back page 0 forever — which is a full page, which
 * never terminates. The first version of this file did exactly that and spun
 * to the iteration cap.
 */
let turnPage: number;

function chain(table: string): any {
  const isTurns = table === 'transcript_turns';
  const self: any = {
    select: () => self,
    eq: () => self,
    in: () => self,
    order: () => self,
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () =>
      Promise.resolve({
        data: { id: CANDIDATE, name: 'Jane Doe', status: 'new' },
        error: null,
      }),
    range(from: number, to: number) {
      ranges.push([from, to]);
      const rows = scenario.turnPages[turnPage] ?? [];
      turnPage += 1;
      self.__result = { data: rows, error: scenario.turnError ?? null };
      return self;
    },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      const result =
        self.__result ??
        (isTurns
          ? { data: [], error: null }
          : table === 'call_sessions'
            ? { data: scenario.sessions, error: null }
            : { data: [], error: null });
      return Promise.resolve(result).then(res, rej);
    },
  };
  return self;
}

function app() {
  const user: AuthUser = {
    id: USER,
    email: 'recruiter@example.com',
    aal: 'aal2',
    active: true,
    appRole: 'admin',
    orgId: null,
  };
  const a = express();
  a.use(express.json());
  a.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT_AAL2) }));
  a.use('/api/candidates', candidatesRouter);
  a.use(finalErrorHandler);
  return a;
}

const get = () => request(app()).get(`/api/candidates/${CANDIDATE}`).set(AUTH);

beforeEach(() => {
  ranges = [];
  turnPage = 0;
  scenario = { sessions: [{ id: S1, duration_sec: 434 }], turnPages: [[]] };
  vi.mocked(supabase.from).mockImplementation((t: string) => chain(t) as never);
});
afterEach(() => vi.restoreAllMocks());

describe('candidate_words', () => {
  it('counts only what the CANDIDATE said', async () => {
    scenario.turnPages = [
      [
        turn(S1, 'bot', 'Hello, thanks for taking the call today, I have a few questions'),
        turn(S1, 'candidate', 'Yes of course'),
        turn(S1, 'candidate', 'I have five years in enterprise sales'),
      ],
    ];
    const res = await get();
    // 3 + 7 = 10 candidate words; the bot's twelve are not the candidate's.
    expect(res.body.sessions[0].candidate_words).toBe(10);
  });

  it('attributes each session its OWN words', async () => {
    // Both sessions come back in one query; mixing them up would put a
    // rescreen's engagement on the call that failed.
    scenario.sessions = [
      { id: S1, duration_sec: 434 },
      { id: S2, duration_sec: 120 },
    ];
    scenario.turnPages = [
      [
        turn(S1, 'candidate', 'one two three'),
        turn(S2, 'candidate', 'four'),
        turn(S1, 'candidate', 'five'),
      ],
    ];
    const res = await get();
    const bySession = Object.fromEntries(
      res.body.sessions.map((s: any) => [s.id, s.candidate_words]),
    );
    expect(bySession[S1]).toBe(4);
    expect(bySession[S2]).toBe(1);
  });

  it('reports a REAL ZERO for a candidate who said nothing on a real call', async () => {
    // The transcript exists, so silence is a fact about the candidate.
    scenario.turnPages = [[turn(S1, 'bot', 'Hello? Are you there?')]];
    const res = await get();
    expect(res.body.sessions[0].candidate_words).toBe(0);
  });

  it('reports NULL when the session has no transcript at all', async () => {
    // Not zero. Zero accuses the candidate of silence; null says we hold no
    // transcript, which is a fact about us.
    scenario.turnPages = [[]];
    const res = await get();
    expect(res.body.sessions[0].candidate_words).toBeNull();
  });

  it('reports NULL — not a short count — when the read fails', async () => {
    // A partial count renders as a confident low number against a real
    // candidate, and nothing on screen would say it came from a failed read.
    scenario.turnPages = [[turn(S1, 'candidate', 'one two three')]];
    scenario.turnError = new Error('pooler reset');
    const res = await get();
    expect(res.body.sessions[0].candidate_words).toBeNull();
  });

  it('PAGES until a short page, and asks for less than the PostgREST cap', async () => {
    // The terminator is "this page came back short". A page size equal to
    // `max_rows` (1000 in config.toml) would make EVERY page short, stopping
    // the loop after the first and undercounting the most talkative
    // candidates first — the exact bug the pagination was added to avoid.
    const full = Array.from({ length: 500 }, () => turn(S1, 'candidate', 'word'));
    scenario.turnPages = [full, [turn(S1, 'candidate', 'tail end')]];
    const res = await get();

    expect(ranges.length).toBe(2);
    const [from, to] = ranges[0];
    expect(to - from + 1).toBeLessThan(1000);
    expect(ranges[1][0]).toBe(to + 1);
    expect(res.body.sessions[0].candidate_words).toBe(502);
  });

  it('ignores empty and whitespace-only turns', async () => {
    scenario.turnPages = [
      [
        turn(S1, 'candidate', '   '),
        turn(S1, 'candidate', null),
        turn(S1, 'candidate', 'two  words'),
      ],
    ];
    const res = await get();
    // The transcript exists, so 2 — not null.
    expect(res.body.sessions[0].candidate_words).toBe(2);
  });

  it('does not query turns at all when there are no sessions', async () => {
    scenario.sessions = [];
    const res = await get();
    expect(ranges).toEqual([]);
    expect(res.body.sessions).toEqual([]);
  });
});
