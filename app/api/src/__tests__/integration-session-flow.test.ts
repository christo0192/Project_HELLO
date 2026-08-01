/**
 * TST-03 — Stitched integration flow (Phase 6 lane L3).
 *
 * Drives the REAL HTTP seams (supertest → express → real route handlers)
 * with only the two I/O boundaries emulated in-memory: Supabase (MemoryDb)
 * and the LLM provider (scripted spawn through the real createClaudeRunner).
 *
 * Stitched public seams exercised:
 *   - routes/screening.ts  (create → transcript → score)
 *   - routes/livekit.ts    (browser-session create + worker join)
 *   - lib/session-lifecycle.ts (createSession / transitionSession CAS)
 *   - lib/worker-context.ts    (resolveWorkerContext — join binding)
 *   - lib/outbox.ts            (upsertTranscriptEvent / poll / mark — REL-02/03)
 *   - lib/queue (MemoryAdapter + Queue) — worker delivery pipeline
 *   - services/assessment.ts   (real scoring path + computeOverall)
 *   - lib/reconciliation.ts    (overdue-scorecard quarantine after scoring loss)
 *
 * No real DB, network, provider, or secrets. All fixtures synthetic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { transitionSession } from '../lib/session-lifecycle.js';
import { upsertTranscriptEvent, getTranscriptEvents } from '../lib/outbox.js';
import {
  MemoryDb,
  setActiveDb,
  bindClaudeHarness,
  getClaudeHarness,
  bindLiveKitHarness,
  createScriptedRunner,
  createQueueHarness,
  enqueueDelivery,
  runWorkerPass,
  drainOutbox,
  runReconciliation,
  seedCandidate,
  seedRole,
  makeUuid,
  type DeliveryEvent,
} from './support/chaos.js';

// ── Test-only env tuning (before any createApp call) ──────────────────
process.env.RATE_LIMIT_WINDOW_SEC = '3600';
process.env.RATE_LIMIT_IP = '100000';
process.env.RATE_LIMIT_DEFAULT = '100000';
process.env.RATE_LIMIT_STRICT = '100000';

// ── Module mocks (hoisted factories; async + dynamic import to avoid
//    import-order/TDZ issues with the harness module) ──────────────────
vi.mock('../lib/supabase.js', async () => {
  const c = await import('./support/chaos.js');
  return { supabase: c.supabaseProxy, RESUME_BUCKET: 'resumes_v2' };
});

vi.mock('../lib/claude.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/claude.js')>();
  const c = await import('./support/chaos.js');
  return c.bindClaudeHarness(real).exports;
});

vi.mock('livekit-server-sdk', async () => {
  const c = await import('./support/chaos.js');
  return c.bindLiveKitHarness().exports;
});

// ── Auth fixture ───────────────────────────────────────────────────────
const JWT_TEST = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH_HEADER = 'Bearer ' + JWT_TEST;
const TEST_ADMIN: AuthUser = {
  id: 'user-admin-0000-0000-000000000001',
  email: 'admin@test.com',
  aal: 'aal2',
  active: true,
  appRole: 'admin',
  orgId: 'org-test',
};

// ── Scripted provider fixtures ─────────────────────────────────────────
const botReply = (message: string, done: boolean) =>
  JSON.stringify({ message, done });

const assessmentFixture = {
  english: { band: 'C1', grammar: 8, vocabulary: 8, fluency: 8, coherence: 8, notes: 'clear' },
  tone: { clarity: 8, confidence: 8, professionalism: 8, sentiment: 'positive', notes: 'professional' },
  communication: {
    score: 8, clarity: 8, structure: 8, listening: 8, rapport: 8,
    english_proficiency: { band: 'C1', grammar: 8, vocabulary: 8, fluency: 8, coherence: 8, notes: 'clear' },
    filler_usage: { level: 'low', impact_score: 8, examples: [], notes: '' },
    native_language_usage: { level: 'none', examples: [], impact_score: 9, notes: '' },
    notes: 'good',
  },
  motivation: { score: 8, notes: 'interested' },
  role_fit: { score: 8, matched_skills: ['TypeScript'], gaps: [], red_flags: [], notes: 'fit' },
  overall_score: 0, // recomputed by computeOverall
  recommendation: 'advance', // recomputed by computeOverall
  summary: 'Strong candidate',
  resume_conflicts: [],
};
const assessmentJson = () => JSON.stringify(assessmentFixture);

// ── Per-test state ─────────────────────────────────────────────────────
let db: MemoryDb;
let app: Express;
let candidateId: string;
let roleId: string;

const WORKER_SECRET = 'w'.repeat(40);

async function seedBase(): Promise<void> {
  const role = await seedRole(db, { id: makeUuid(900), title: 'Frontend Engineer' });
  roleId = role.id as string;
  const candidate = await seedCandidate(db, {
    id: makeUuid(901),
    name: 'Alice Example',
    role_id: roleId,
  });
  candidateId = candidate.id as string;
}

beforeEach(async () => {
  db = new MemoryDb();
  setActiveDb(db);
  await seedBase();
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  app = createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(TEST_ADMIN, JWT_TEST) },
  });
});

afterEach(() => {
  delete process.env.WORKER_CONTEXT_SECRET;
  db.reset();
  setActiveDb(db);
});

/** Configure the harness provider for this test (real runner + real breaker). */
function configureProvider(script: Parameters<typeof createScriptedRunner>[0]['script'], opts?: {
  failureThreshold?: number; cooldownMs?: number;
}): { runner: ReturnType<typeof createScriptedRunner>['runner'] } {
  const harness = getClaudeHarness();
  const { runner } = createScriptedRunner({
    real: harness.getReal(),
    script,
    failureThreshold: opts?.failureThreshold,
    cooldownMs: opts?.cooldownMs,
  });
  harness.configure(runner);
  return { runner };
}

// ═══════════════════════════════════════════════════════════════════════
// Happy path: create → join → transcript → score (single session, real seams)
// ═══════════════════════════════════════════════════════════════════════

describe('TST-03 stitched integration flow', () => {
  it('create→join→transcript→score happy path over real seams', async () => {
    configureProvider([
      { stdout: botReply('Tell me about your React experience.', false) },
      { stdout: botReply('Thanks, we are done here.', true) },
      { stdout: assessmentJson() },
    ]);

    // ── 1. CREATE (browser session via livekit /start) ──────────────────
    const created = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: candidateId });

    expect(created.status).toBe(201);
    const sessionId = created.body.session_id as string;
    const roomName = created.body.room_name as string;
    expect(roomName).toBe(`screening-${sessionId}`);

    let session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('waiting');
    expect(session.external_call_id).toBe(roomName);
    expect(session.mode).toBe('browser');
    expect(session.candidate_id).toBe(candidateId);

    // ── 2. JOIN (worker-context binding + CAS claim) ────────────────────
    const joined = await request(app)
      .post('/api/livekit/worker-context')
      .set('Authorization', `Bearer ${WORKER_SECRET}`)
      .send({ session_id: sessionId, room_name: roomName });
    expect(joined.status).toBe(200);
    expect(joined.body.ok).toBe(true);
    expect(joined.body.context.session_id).toBe(sessionId);
    expect(joined.body.context.room_name).toBe(roomName);
    expect(joined.body.context.status).toBe('waiting');

    const claim = await transitionSession(sessionId, 'waiting', 'in_progress');
    expect(claim.ok).toBe(true);
    session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('in_progress');

    // ── 3. WORKER DELIVERY PIPELINE (real queue + durable events) ──────
    const qh = createQueueHarness();
    const workerEvents: DeliveryEvent[] = [
      { sessionId, turnIndex: 1, speaker: 'candidate', text: 'I have five years of React.' },
      { sessionId, turnIndex: 2, speaker: 'bot', text: 'Which part did you enjoy most?' },
      { sessionId, turnIndex: 3, speaker: 'candidate', text: 'Design systems and performance.' },
    ];
    for (const evt of workerEvents) {
      await enqueueDelivery(qh, evt);
    }
    // Duplicate enqueue with the same dedupKey must NOT create a second job.
    const dup = await enqueueDelivery(qh, workerEvents[0]);
    expect(dup.payload.turnIndex).toBe(1);

    const pass = await runWorkerPass(qh, {
      apply: async (p) => {
        const { error } = await upsertTranscriptEvent(p.sessionId, p.turnIndex, p.speaker, p.text);
        expect(error).toBeNull();
      },
    });
    expect(pass.killed).toBe(0);
    expect(pass.processed).toBe(3);

    // Durable ordered event store: 3 deduped events, strictly increasing seq.
    const events = await getTranscriptEvents(sessionId);
    expect(events.data).toHaveLength(3);
    expect(events.data.map((e) => e.sequence)).toEqual([1, 2, 3]);

    // Outbox delivery (REL-02/03) over the real poll/mark seams.
    const outbox = await drainOutbox();
    expect(outbox.published).toBe(3);
    expect(outbox.failed).toBe(0);
    expect(outbox.pendingAfter).toBe(0);

    // ── 4. TRANSCRIPT via the API (provider-driven conversation) ────────
    const turn1 = await request(app)
      .post(`/api/screening/${sessionId}/turn`)
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'I have five years of React.' });
    expect(turn1.status).toBe(200);
    expect(turn1.body.done).toBe(false);
    expect(turn1.body.message).toContain('React');

    // ── 5. SCORE (final turn → CAS completed → real assessment) ─────────
    const turn2 = await request(app)
      .post(`/api/screening/${sessionId}/turn`)
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'I left my last job for growth.' });
    expect(turn2.status).toBe(200);
    expect(turn2.body.done).toBe(true);
    expect(turn2.body.scoringStatus).toBe('done');
    expect(turn2.body.assessment).toBeDefined();
    expect(turn2.body.assessment.overall_score).toBeGreaterThanOrEqual(0);

    session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('completed');
    // VOI-08: after scoring, terminal_reason transitions to assessment_done
    // as a non-concurrent repeat guard (Phase 8 audit fix).
    expect(session.terminal_reason).toBe('assessment_done');

    const assessments = db.rows('assessments').filter((a) => a.session_id === sessionId);
    expect(assessments).toHaveLength(1);
    expect((assessments[0].overall_score as number)).toBe(80);
    expect(assessments[0].recommendation).toBe('advance');
    expect(assessments[0].provenance).toBeDefined();

    const candidate = db.findOne('candidates', (r) => r.id === candidateId)!;
    expect(candidate.status).toBe('screened');

    // ── 6. Read-back: session + transcript + assessment ─────────────────
    const summary = await request(app)
      .get(`/api/screening/${sessionId}`)
      .set('Authorization', AUTH_HEADER);
    expect(summary.status).toBe(200);
    expect(summary.body.session.status).toBe('completed');
    expect(summary.body.transcript).toHaveLength(4); // cand, bot, cand, bot
    expect(summary.body.transcript[0].speaker).toBe('candidate');
    expect(summary.body.assessment.overall_score).toBe(80);

    // ── 7. Terminal-state guards ────────────────────────────────────────
    const lateTurn = await request(app)
      .post(`/api/screening/${sessionId}/turn`)
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'one more thing' });
    expect(lateTurn.status).toBe(409);

    const lateJoin = await request(app)
      .post('/api/livekit/worker-context')
      .set('Authorization', `Bearer ${WORKER_SECRET}`)
      .send({ session_id: sessionId, room_name: roomName });
    expect(lateJoin.status).toBe(404);
    expect(lateJoin.body.error).toBe('ERR_SESSION_NOT_ACTIVE');
  });

  it('simulation create path: /api/screening/start writes the opening turn and activates the session', async () => {
    configureProvider([{ stdout: botReply('Hello!', false) }]);

    const res = await request(app)
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: candidateId });
    expect(res.status).toBe(201);
    expect(res.body.done).toBe(false);

    const sessionId = res.body.session_id as string;
    const session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('in_progress');
    expect(session.mode).toBe('simulation');
    expect(session.provenance).toBeDefined();

    const turns = db.rows('transcript_turns').filter((t) => t.session_id === sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0].turn_index).toBe(0);
    expect(turns[0].speaker).toBe('bot');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Error paths
  // ═══════════════════════════════════════════════════════════════════════

  it('error: livekit /start with an unknown candidate fails closed (500)', async () => {
    const res = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: makeUuid(404) });
    expect(res.status).toBe(500);
    expect(res.body.error.type).toBe('internal_error');
    // No session row must be left behind.
    expect(db.count('call_sessions')).toBe(0);
  });

  it('error: screening /start rejects a missing candidate_id (400 validation)', async () => {
    const res = await request(app)
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('validation_error');
  });

  it('error: worker join with a mismatched room binding is denied (403)', async () => {
    configureProvider([{ stdout: botReply('x', false) }]);
    const created = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: candidateId });
    const sessionId = created.body.session_id as string;

    const res = await request(app)
      .post('/api/livekit/worker-context')
      .set('Authorization', `Bearer ${WORKER_SECRET}`)
      .send({ session_id: sessionId, room_name: 'screening-11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ERR_BINDING_MISMATCH');
  });

  it('error: turn with a malformed session id is rejected (400 validation)', async () => {
    const res = await request(app)
      .post('/api/screening/not-a-uuid/turn')
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('validation_error');
  });

  it('provider failure mid-conversation: turn 500s, session stays in_progress, healthy retry succeeds', async () => {
    // First provider call fails (non-zero exit); the second succeeds.
    configureProvider([
      { exitCode: 2 },
      { stdout: botReply('Understood — continue.', false) },
    ]);

    const created = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: candidateId });
    const sessionId = created.body.session_id as string;
    await transitionSession(sessionId, 'waiting', 'in_progress');

    const failed = await request(app)
      .post(`/api/screening/${sessionId}/turn`)
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'I have five years of React.' });
    expect(failed.status).toBe(500);
    expect(failed.body.error.type).toBe('internal_error');

    // The session must NOT have been corrupted into a terminal state.
    const session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('in_progress');

    // Durable event store unaffected by the failed provider call.
    const events = await getTranscriptEvents(sessionId);
    expect(events.data).toHaveLength(0);

    // Healthy retry completes the turn (at-least-once semantics on turns —
    // the retried candidate turn is re-appended; see handoff limitation).
    const retried = await request(app)
      .post(`/api/screening/${sessionId}/turn`)
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'I have five years of React.' });
    expect(retried.status).toBe(200);
    expect(retried.body.done).toBe(false);
    expect(db.findOne('call_sessions', (r) => r.id === sessionId)!.status).toBe('in_progress');
  });

  it('scoring failure: session completes with scoringStatus=error, no assessment; reconciler quarantines (overdue_scorecard)', async () => {
    // Turn reply succeeds (done:true) but the scoring call fails (exit 2).
    configureProvider([
      { stdout: botReply('We are done.', true) },
      { exitCode: 2 },
    ]);

    const created = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: candidateId });
    const sessionId = created.body.session_id as string;
    await transitionSession(sessionId, 'waiting', 'in_progress');

    const final = await request(app)
      .post(`/api/screening/${sessionId}/turn`)
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'That is all from me.' });
    expect(final.status).toBe(200);
    expect(final.body.done).toBe(true);
    expect(final.body.scoringStatus).toBe('error');
    expect(final.body.assessment).toBeNull();

    // Session completed (ownership), but NO assessment row persisted.
    const session = db.findOne('call_sessions', (r) => r.id === sessionId)!;
    expect(session.status).toBe('completed');
    expect(db.rows('assessments').filter((a) => a.session_id === sessionId)).toHaveLength(0);

    // REAL reconciliation detects the overdue scorecard and quarantines it.
    const { report, repairs } = await runReconciliation(makeUuid(700), {
      waitingTimeoutMs: 0, createdTimeoutMs: 0, progressTimeoutMs: 0,
    });
    expect(report.issues.some((i) => i.category === 'overdue_scorecard')).toBe(true);
    expect(repairs.some((r) => r.result.action === 'quarantine_session')).toBe(true);

    const quarantined = db.findOne('quarantined_sessions', (r) => r.session_id === sessionId);
    expect(quarantined).not.toBeNull();
    expect(db.rows('reconciliation_log').filter((l) => l.session_id === sessionId).length).toBeGreaterThan(0);
  });
});
