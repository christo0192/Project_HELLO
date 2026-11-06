/**
 * GET /api/interview-rounds: the R1 queue, one server page at a time.
 *
 * What this pins is what the queue must never get wrong: who sees which round (the candidate-access
 * rule, so an interviewer only ever pages through their own), which view a round sits in, what an
 * appeal withholds and that a view cannot give it away, what a withdrawn consent says, and that a
 * failed read fails the page rather than dropping rows. Scale is driven in scale-guard.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

vi.mock('../lib/supabase.js', async () => {
  const { scaleDb } = await import('./support/scale-db.js');
  return { supabase: scaleDb.client, RESUME_BUCKET: 'resumes_v2' };
});

import { parseR1QueueQuery, readR1Queue } from '../lib/r1/queue.js';
import { r1Router } from '../routes/r1.js';
import { scaleDb as engine, type Row } from './support/scale-db.js';

const OWNER = '40000000-0000-4000-8000-000000000001';
const OTHER = '50000000-0000-4000-8000-000000000001';
const pad = (i: number): string => String(i).padStart(12, '0');
const candidateId = (i: number): string => `10000000-0000-4000-8000-${pad(i)}`;
const roundId = (i: number): string => `20000000-0000-4000-8000-${pad(i)}`;
const sessionId = (i: number, start = 0): string => `30000000-0000-4000-8000-${pad(i * 10 + start)}`;
/** Round i was sent i days after 2026-10-01. */
const sentAt = (i: number): string => new Date(Date.UTC(2026, 9, 1 + i)).toISOString();
/** The views read a link's expiry against the real clock. */
const LINK_ALIVE = '2099-01-01T00:00:00.000Z';
const LINK_LAPSED = '2026-10-04T00:00:00.000Z';

function addRound(i: number, over: Row = {}, candidateOver: Row = {}): void {
  (engine.tables.candidates ??= []).push({
    id: candidateId(i), owner_id: OWNER, name: `Candidate ${i}`, email: `c${i}@example.com`, decision_use_blocked_at: null, ...candidateOver,
  });
  (engine.tables.interview_rounds ??= []).push({
    id: roundId(i), candidate_id: candidateId(i), status: 'completed', expires_at: LINK_ALIVE, attempts_allowed: 2, attempts_counted: 1,
    recommendation: 'hold', overall: 58, status_write: 'hold_flag', pending_reject_until: null, consent_locale: 'en-IN',
    created_at: sentAt(i), created_by: OWNER, link_token_digest: 'd'.repeat(64), status_write_audit: { secret: 'SECRET-AUDIT' }, ...over,
  });
}

function addAttempt(i: number, start = 0, over: Row = {}, session: Row = {}, recording: Row | null = {}): void {
  (engine.tables.interview_round_attempts ??= []).push({
    session_id: sessionId(i, start), round_id: roundId(i), attempt_number: start + 1, persona_id: 'p1_career_switcher', counted: true,
    outcome: 'complete', created_at: sentAt(i), nonce_digest: 'n'.repeat(64), ...over,
  });
  (engine.tables.call_sessions ??= []).push({
    id: sessionId(i, start), candidate_id: candidateId(i), interview_round_id: roundId(i), status: 'completed',
    ended_at: sentAt(i + 1), external_call_id: 'screening-secret-room', ...session,
  });
  if (recording === null) return;
  (engine.tables.interview_round_recordings ??= []).push({
    session_id: sessionId(i, start), round_id: roundId(i), status: 'ready', layout: 'combined', has_video: true, started_at_ms: 1_800_000_000_000,
    duration_ms: 1_500_000, camera_off_ms: 0, degraded_at_ms: null, degraded_reason: null, failure_reason: null,
    delete_after: '2027-02-01T00:00:00Z', delete_requested_at: null, delete_reason: null, deleted_at: null, updated_at: sentAt(i + 1),
    combined_key: 'r1/secret/key.mp4', combined_etag: 'SECRET-ETAG', upload_id: 'SECRET-UPLOAD', ...recording,
  });
}

function appFor(role: 'admin' | 'interviewer' | 'viewer', id = OWNER, active = true) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { authUser: unknown }).authUser = { id, appRole: role, active };
    next();
  });
  app.use('/api', r1Router);
  return app;
}

const list = (query = '', role: 'admin' | 'interviewer' | 'viewer' = 'admin', id = OWNER, active = true) =>
  request(appFor(role, id, active)).get(`/api/interview-rounds${query}`);

const rowIds = (body: { rounds: Row[] }): unknown[] => body.rounds.map((round) => round.id);

beforeEach(() => {
  engine.reset({ overflowAt: 100 });
  engine.scrambleTies = true;
  engine.tables.interview_round_consents = [];
  vi.stubEnv('R1_ENABLED', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the views', () => {
  /** Every status_write the scorer can leave on a finished round (0122), one round each. */
  const OPEN = [null, 'human_review', 'hold_flag', 'flag_off', 'pending_reject', 'pending_reject_dropped', 'cas_lost', 'decision_blocked', 'round_not_final'];
  const SETTLED = ['advanced', 'rejected', 'pending_reject_cancelled'];

  it('opens on To review, oldest first: every finished round nobody has settled', async () => {
    OPEN.forEach((write, i) => addRound(i, { status_write: write }));
    SETTLED.forEach((write, i) => addRound(20 + i, { status_write: write }));
    addRound(30, { status: 'invited', status_write: null });
    addRound(31, { status: 'in_progress', status_write: null });
    addRound(32, { status: 'cancelled', status_write: null, attempts_counted: 0, recommendation: null, overall: null });
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ view: 'to-review', sort: 'oldest', page: 1, total: OPEN.length });
    expect(rowIds(res.body)).toEqual(OPEN.map((_write, i) => roundId(i)));
  });

  it('keeps a scored round in To review when its retake lapsed, and leaves out an unused link that lapsed', async () => {
    addRound(0, { status: 'expired', status_write: 'hold_flag' });
    addRound(1, { status: 'expired', status_write: null, attempts_counted: 0, recommendation: null, overall: null });
    addRound(2, { status: 'expired', status_write: 'advanced' });
    expect(rowIds((await list('?view=to-review')).body)).toEqual([roundId(0)]);
    expect(rowIds((await list('?view=reviewed')).body)).toEqual([roundId(2)]);
    expect((await list('?view=all')).body.total).toBe(3);
  });

  it('keeps a scored round in the queue when its retake was cancelled, and leaves out a link cancelled with nothing counted', async () => {
    addRound(0, { status: 'cancelled', status_write: 'hold_flag' });
    addRound(1, { status: 'cancelled', status_write: 'pending_reject_dropped', recommendation: 'reject', overall: 31 });
    addRound(2, { status: 'cancelled', status_write: 'advanced', recommendation: 'advance', overall: 81 });
    addRound(3, { status: 'cancelled', status_write: null, attempts_counted: 0, recommendation: null, overall: null });
    expect(rowIds((await list('?view=to-review')).body)).toEqual([roundId(0), roundId(1)]);
    expect(rowIds((await list('?view=reviewed')).body)).toEqual([roundId(2)]);
    expect((await list('?view=in-progress')).body.total).toBe(0);
    expect((await list('?view=all')).body.total).toBe(4);
  });

  describe('a link that has lapsed, whatever the status still says', () => {
    const IN_VIEW = ['to-review', 'in-progress', 'reviewed'] as const;

    /** Which of the three views hold each round. */
    async function viewsOf(): Promise<Record<string, unknown[]>> {
      const seen: Record<string, unknown[]> = {};
      for (const view of IN_VIEW) seen[view] = rowIds((await list(`?view=${view}&sort=oldest`)).body);
      return seen;
    }

    it('leaves In progress when nothing was counted, and stays only in All', async () => {
      addRound(0, { status: 'invited', status_write: null, attempts_counted: 0, recommendation: null, overall: null, expires_at: LINK_LAPSED });
      addRound(1, { status: 'in_progress', status_write: null, attempts_counted: 0, recommendation: null, overall: null, expires_at: LINK_LAPSED });
      addAttempt(1, 0, { counted: false, outcome: 'provider_error' }, { status: 'failed' }, null);
      expect(await viewsOf()).toEqual({ 'to-review': [], 'in-progress': [], reviewed: [] });
      expect((await list('?view=all')).body.total).toBe(2);
    });

    it.each(['invited', 'in_progress'])('brings a scored round whose retake lapsed back to To review, from %s', async (status) => {
      addRound(0, { status, status_write: 'hold_flag', expires_at: LINK_LAPSED });
      expect(await viewsOf()).toEqual({ 'to-review': [roundId(0)], 'in-progress': [], reviewed: [] });
    });

    it('brings back a round that was never scored, as it was before the retake', async () => {
      addRound(0, { status: 'invited', status_write: null, recommendation: null, overall: null, expires_at: LINK_LAPSED });
      expect(await viewsOf()).toEqual({ 'to-review': [roundId(0)], 'in-progress': [], reviewed: [] });
    });

    it('puts a settled round whose retake lapsed in Reviewed', async () => {
      addRound(0, { status: 'invited', status_write: 'advanced', expires_at: LINK_LAPSED });
      expect(await viewsOf()).toEqual({ 'to-review': [], 'in-progress': [], reviewed: [roundId(0)] });
    });

    it('keeps a round with a live link in In progress, with its older result', async () => {
      addRound(0, { status: 'invited', status_write: 'hold_flag' });
      expect(await viewsOf()).toEqual({ 'to-review': [], 'in-progress': [roundId(0)], reviewed: [] });
    });

    it('gives nothing away for a blocked candidate, once the link has lapsed too', async () => {
      addRound(0, { status: 'invited', status_write: 'hold_flag', expires_at: LINK_LAPSED }, { decision_use_blocked_at: '2026-11-03T00:00:00Z' });
      expect(await viewsOf()).toEqual({ 'to-review': [], 'in-progress': [], reviewed: [] });
      expect((await list('?view=all')).body.total).toBe(1);
    });

    it('leaves an interview that outlasted its link in All, where its attempt says it is running', async () => {
      addRound(0, { status: 'in_progress', status_write: null, attempts_counted: 0, recommendation: null, overall: null, expires_at: LINK_LAPSED });
      addAttempt(0, 0, { counted: false, outcome: null }, { status: 'in_progress', ended_at: null });
      expect(await viewsOf()).toEqual({ 'to-review': [], 'in-progress': [], reviewed: [] });
      expect((await list('?view=all')).body.rounds[0].attempts[0].in_progress).toBe(true);
    });

    it('takes the instant of expiry as lapsed, as the candidate routes do', async () => {
      addRound(0, { status: 'invited', status_write: null, attempts_counted: 0, expires_at: LINK_LAPSED });
      const actor = { id: OWNER, appRole: 'admin', active: true } as const;
      const inProgress = parseR1QueueQuery({ view: 'in-progress' })!;
      const at = async (ms: number) => {
        const result = await readR1Queue(engine.client as never, actor, inProgress, ms);
        return result.kind === 'ok' ? result.body.total : null;
      };
      expect(await at(Date.parse(LINK_LAPSED) - 1)).toBe(1);
      expect(await at(Date.parse(LINK_LAPSED))).toBe(0);
    });
  });

  it('Reviewed is the rounds a status write settled, newest first', async () => {
    SETTLED.forEach((write, i) => addRound(i, { status_write: write }));
    addRound(9, { status_write: 'flag_off' });
    const res = await list('?view=reviewed');
    expect(res.body).toMatchObject({ view: 'reviewed', sort: 'newest', total: 3 });
    expect(rowIds(res.body)).toEqual([roundId(2), roundId(1), roundId(0)]);
  });

  it('In progress is a link out or an interview running, even with a result from before a retake', async () => {
    addRound(0, { status: 'invited', status_write: 'hold_flag' });
    addRound(1, { status: 'in_progress', status_write: null });
    addRound(2);
    const res = await list('?view=in-progress');
    expect(res.body).toMatchObject({ view: 'in-progress', sort: 'newest', total: 2 });
    expect(rowIds(res.body)).toEqual([roundId(1), roundId(0)]);
  });

  it('All is every round, newest first', async () => {
    addRound(0);
    addRound(1, { status: 'cancelled', status_write: null });
    addRound(2, { status: 'invited', status_write: null });
    expect(rowIds((await list('?view=all')).body)).toEqual([roundId(2), roundId(1), roundId(0)]);
  });

  it('takes the sort it is asked for, in any view', async () => {
    addRound(0);
    addRound(1);
    expect(rowIds((await list('?sort=newest')).body)).toEqual([roundId(1), roundId(0)]);
    expect(rowIds((await list('?view=all&sort=oldest')).body)).toEqual([roundId(0), roundId(1)]);
  });

  it('hides a staff dry run by default, and marks it when asked for', async () => {
    addRound(0, { consent_locale: 'en-IN-x-staff' });
    addRound(1);
    for (const view of ['to-review', 'all']) {
      const res = await list(`?view=${view}`);
      expect(rowIds(res.body)).toEqual([roundId(1)]);
      expect(res.body.total).toBe(1);
    }
    const shown = await list('?view=all&dry_runs=include&sort=oldest');
    expect(shown.body.rounds.map((round: Row) => round.is_staff_dry_run)).toEqual([true, false]);
  });
});

describe('who sees what', () => {
  beforeEach(() => {
    addRound(0, {}, { owner_id: OWNER });
    addRound(1, {}, { owner_id: OTHER });
    addRound(2, {}, { owner_id: null });
  });

  it.each(['admin', 'viewer'] as const)('%s sees every candidate', async (role) => {
    expect(rowIds((await list('', role, OTHER)).body)).toEqual([roundId(0), roundId(1), roundId(2)]);
  });

  it('an interviewer sees only candidates they own, whoever sent the round', async () => {
    engine.tables.interview_rounds[0].created_by = OTHER;
    const res = await list('', 'interviewer', OWNER);
    expect(rowIds(res.body)).toEqual([roundId(0)]);
    expect(res.body.total).toBe(1);
  });

  it('a search cannot reach past that rule, and the count says nothing about what it found elsewhere', async () => {
    const res = await list('?q=Candidate%201', 'interviewer', OWNER);
    expect(res.body).toMatchObject({ rounds: [], total: 0 });
  });

  it('refuses an inactive user', async () => {
    const res = await list('', 'admin', OWNER, false);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'access_denied' });
  });
});

describe('the search', () => {
  beforeEach(() => {
    addRound(0, {}, { name: 'Ava Example' });
    addRound(1, {}, { name: 'Bela 100% Example' });
    addRound(2, {}, { name: 'Bela Example' });
    addRound(3, {}, { name: null });
  });

  it('finds a part of the name, in any case, across the view', async () => {
    expect(rowIds((await list('?q=ava')).body)).toEqual([roundId(0)]);
    expect((await list('?q=EXAMPLE')).body.total).toBe(3);
  });

  it('reads a wildcard as the character it is', async () => {
    expect(rowIds((await list('?q=100%25')).body)).toEqual([roundId(1)]);
    expect((await list('?q=_ela')).body.total).toBe(0);
    expect((await list('?q=a%25e')).body.total).toBe(0);
    expect((await list('?q=b*a')).body.total).toBe(0);
  });

  it('treats a blank search as no search, and refuses an over-long one', async () => {
    expect((await list('?q=%20%20')).body.total).toBe(4);
    expect((await list(`?q=${'x'.repeat(101)}`)).status).toBe(400);
  });
});

describe('paging', () => {
  beforeEach(() => {
    for (let i = 0; i < 30; i += 1) addRound(i);
  });

  it('answers one page of 25 and the total, and page 2 continues it', async () => {
    const first = await list();
    expect(first.body).toMatchObject({ page: 1, page_size: 25, total: 30 });
    expect(first.body.rounds).toHaveLength(25);
    const second = await list('?page=2');
    expect(second.body).toMatchObject({ page: 2, total: 30 });
    expect(rowIds(second.body)).toEqual([25, 26, 27, 28, 29].map(roundId));
  });

  it('keeps a stable order for rounds sent in the same instant', async () => {
    for (const round of engine.tables.interview_rounds) round.created_at = sentAt(0);
    const seen = new Set<unknown>();
    for (const page of [1, 2]) for (const id of rowIds((await list(`?page=${page}`)).body)) seen.add(id);
    expect(seen.size).toBe(30);
  });

  it('takes a smaller page, up to its limit', async () => {
    expect((await list('?page_size=5')).body.rounds).toHaveLength(5);
    expect((await list('?page_size=51')).status).toBe(400);
  });

  it.each(['?page=9', '?page=3'])('answers the last page, and says so, for %s: a stale link is not an error', async (query) => {
    const res = await list(query);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 2, total: 30 });
    expect(res.body.rounds).toHaveLength(5);
  });

  it('answers the last page for a page that starts exactly at the end, which PostgREST does not refuse', async () => {
    engine.tables.interview_rounds.length = 25;
    const res = await list('?page=2');
    expect(res.body).toMatchObject({ page: 1, total: 25 });
    expect(res.body.rounds).toHaveLength(25);
  });

  it('answers 503 when the count behind a stale page fails, rather than an empty page', async () => {
    engine.failWhen = (q) => q.table === 'interview_rounds' && q.range === null;
    const res = await list('?page=9');
    expect(res.status).toBe(503);
  });

  it('answers an empty first page for a page past the end of nothing', async () => {
    const res = await list('?page=4&q=nobody');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, total: 0, rounds: [] });
  });

  it.each(['?page=0', '?page=-1', '?page=1.5', '?page=x', '?view=nope', '?sort=score', '?page_size=0', '?dry_runs=yes', '?view=all&view=to-review', '?q=a&q=b'])(
    'refuses %s',
    async (query) => {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_query' });
      expect(engine.queries).toEqual([]);
    },
  );
});

describe('a row', () => {
  it('carries the candidate, the AI result and each attempt with its recording, in the order they started', async () => {
    addRound(0, { pending_reject_until: '2026-11-02T00:00:00Z', recommendation: 'reject', overall: 31, status_write: 'pending_reject' });
    addAttempt(0, 1, { attempt_number: 2, created_at: sentAt(2) }, { ended_at: sentAt(3) }, { status: 'partial' });
    addAttempt(0, 0, {}, {}, null);
    const { body } = await list();
    expect(body.rounds).toHaveLength(1);
    const [row] = body.rounds;
    expect(row).toMatchObject({
      id: roundId(0), candidate_id: candidateId(0), candidate_name: 'Candidate 0', status: 'completed', attempts_allowed: 2, attempts_counted: 1,
      recommendation: 'reject', overall: 31, status_write: 'pending_reject', pending_reject_until: '2026-11-02T00:00:00Z',
      scores_withheld: false, is_staff_dry_run: false, created_at: sentAt(0),
    });
    expect(row.attempts.map((attempt: Row) => attempt.session_id)).toEqual([sessionId(0, 0), sessionId(0, 1)]);
    expect(row.attempts[0]).toMatchObject({
      attempt_number: 1, counted: true, outcome: 'complete', session_status: 'completed', ended_at: sentAt(1), in_progress: false, consent_withdrawn: false, recording: { state: 'none' },
    });
    expect(row.attempts[1].recording).toMatchObject({ state: 'partial', has_video: true, duration_ms: 1_500_000 });
  });

  it('says an interview is still running, and a round with no attempt has none', async () => {
    addRound(0, { status: 'in_progress', status_write: null });
    addAttempt(0, 0, {}, { status: 'in_progress', ended_at: null });
    addRound(1, { status: 'invited', status_write: null });
    const { body } = await list('?view=in-progress&sort=oldest');
    expect(body.rounds[0].attempts[0]).toMatchObject({ in_progress: true, ended_at: null });
    expect(body.rounds[1].attempts).toEqual([]);
  });

  it('passes on no key, URL, room, digest, contact detail or audit row, and not the join itself', async () => {
    addRound(0);
    addAttempt(0);
    const res = await list();
    const text = JSON.stringify(res.body);
    for (const secret of ['SECRET', 'screening-secret-room', 'r1/secret', 'c0@example.com', 'link_token_digest', 'nonce_digest']) {
      expect(text).not.toContain(secret);
    }
    expect(res.body.rounds[0]).not.toHaveProperty('candidates');
    expect(res.body.rounds[0]).not.toHaveProperty('consent_locale');
  });

  it('is never cached', async () => {
    addRound(0);
    expect((await list()).headers['cache-control']).toBe('no-store');
  });

  it('reads a recording as deleted once consent is withdrawn, before the erase job has run', async () => {
    addRound(0);
    addAttempt(0);
    engine.tables.interview_round_consents = [{ round_id: roundId(0), withdrawn_at: sentAt(5), proof: { decision: 'withdrawn' } }];
    const { body } = await list();
    expect(body.rounds[0].attempts[0].recording).toMatchObject({ state: 'deleted', reason: 'consent_withdrawn', duration_ms: null });
    expect(body.rounds[0].attempts[0].consent_withdrawn).toBe(true);
  });

  it('says consent was withdrawn for an attempt that left no recording, which has nothing else to show it', async () => {
    addRound(0);
    addAttempt(0, 0, {}, {}, null);
    engine.tables.interview_round_consents = [{ round_id: roundId(0), withdrawn_at: sentAt(5), proof: { decision: 'withdrawn' } }];
    const { body } = await list();
    expect(body.rounds[0].attempts[0]).toMatchObject({ consent_withdrawn: true, recording: { state: 'none' } });
  });

  it('leaves a recording alone when a consent was only superseded', async () => {
    addRound(0);
    addAttempt(0);
    engine.tables.interview_round_consents = [{ round_id: roundId(0), withdrawn_at: sentAt(5), proof: { decision: 'superseded' } }];
    expect((await list()).body.rounds[0].attempts[0].recording.state).toBe('ready');
  });
});

describe('while an appeal blocks decision use', () => {
  const BLOCKED = { decision_use_blocked_at: '2026-11-03T00:00:00Z' };

  it('withholds the result and everything that gives it away', async () => {
    addRound(0, { recommendation: 'reject', overall: 31, status_write: 'pending_reject', pending_reject_until: '2026-11-02T00:00:00Z' }, BLOCKED);
    const { body } = await list('?view=all');
    expect(body.rounds[0]).toMatchObject({ recommendation: null, overall: null, status_write: null, pending_reject_until: null, scores_withheld: true });
  });

  it('keeps the round in All and In progress, and out of To review and Reviewed, so a view cannot give the verdict away', async () => {
    addRound(0, { status_write: 'hold_flag' }, BLOCKED);
    addRound(1, { status_write: 'advanced' }, BLOCKED);
    addRound(2, { status: 'invited', status_write: null }, BLOCKED);
    expect((await list('?view=to-review')).body.total).toBe(0);
    expect((await list('?view=reviewed')).body.total).toBe(0);
    expect((await list('?view=all')).body.total).toBe(3);
    expect(rowIds((await list('?view=in-progress')).body)).toEqual([roundId(2)]);
  });
});

describe('GET /api/candidates/:id/interview-rounds', () => {
  const rounds = async (i: number) => (await request(appFor('admin')).get(`/api/candidates/${candidateId(i)}/interview-rounds`)).body.rounds as Row[];

  it('marks a staff dry run, and keeps the notice it was given to itself', async () => {
    addRound(0, { consent_locale: 'en-IN-x-staff' });
    addRound(1);
    expect((await rounds(0))[0]).toMatchObject({ id: roundId(0), is_staff_dry_run: true });
    expect((await rounds(1))[0]).toMatchObject({ id: roundId(1), is_staff_dry_run: false });
    expect((await rounds(0))[0]).not.toHaveProperty('consent_locale');
  });

  it('still marks it while an appeal withholds the result', async () => {
    addRound(0, { consent_locale: 'en-IN-x-staff' }, { decision_use_blocked_at: '2026-11-03T00:00:00Z' });
    expect((await rounds(0))[0]).toMatchObject({ recommendation: null, scores_withheld: true, is_staff_dry_run: true });
  });

  it('gives each attempt exactly what the queue gives it, so the two screens read a round alike', async () => {
    addRound(0);
    addAttempt(0, 0, {}, { started_at: sentAt(0) });
    addAttempt(0, 1, { counted: false, outcome: null }, { status: 'in_progress', ended_at: null }, null);
    const queued = (await list('?view=all')).body.rounds[0];
    const [round] = await rounds(0);
    expect(round.attempts).toEqual(queued.attempts);
    expect(round.attempts).toMatchObject([
      { session_status: 'completed', started_at: sentAt(0), ended_at: sentAt(1), in_progress: false, consent_withdrawn: false },
      { session_status: 'in_progress', ended_at: null, in_progress: true },
    ]);
  });

  it('reads a recording as deleted once consent is withdrawn, as the queue does', async () => {
    addRound(0);
    addAttempt(0);
    engine.tables.interview_round_consents = [{ round_id: roundId(0), withdrawn_at: sentAt(5), proof: { decision: 'withdrawn' } }];
    expect((await rounds(0))[0].attempts).toMatchObject([{ consent_withdrawn: true, recording: { state: 'deleted', reason: 'consent_withdrawn' } }]);
  });

  it.each(['interview_round_attempts', 'interview_round_recordings', 'call_sessions', 'interview_round_consents'])(
    'answers without attempts, never with half of them, when %s fails',
    async (table) => {
      addRound(0);
      addAttempt(0);
      engine.failWhen = (q) => q.table === table;
      const [round] = await rounds(0);
      expect(round).toMatchObject({ id: roundId(0) });
      expect(round).not.toHaveProperty('attempts');
    },
  );
});

describe('a read that fails', () => {
  beforeEach(() => {
    addRound(0);
    addAttempt(0);
  });

  it.each(['interview_rounds', 'interview_round_attempts', 'interview_round_recordings', 'call_sessions', 'interview_round_consents'])(
    'answers 503, never a partial page, when %s fails',
    async (table) => {
      engine.failWhen = (q) => q.table === table;
      const res = await list();
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'service_unavailable' });
    },
  );

  it('answers 503, and the request ends, when the client throws', async () => {
    engine.throwWhen = (q) => q.table === 'interview_round_attempts';
    const res = await list();
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
  });
});

describe('what the sidebar reads', () => {
  it('says whether this server runs R1', async () => {
    expect((await list('?view=all&page_size=1')).body.r1_deployed).toBe(true);
    vi.stubEnv('R1_ENABLED', 'false');
    expect((await list('?view=all&page_size=1')).body.r1_deployed).toBe(false);
  });

  it('answers for a viewer, who cannot read availability', async () => {
    addRound(0);
    const res = await list('?view=all&page_size=1&dry_runs=include', 'viewer', OTHER);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});
