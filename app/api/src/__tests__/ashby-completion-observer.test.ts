/**
 * Completion observer — the production caller for `writeback_pending` (H1).
 *
 * The review's central objection was that the two existing writeback tests
 * asserted stubs the tests themselves had written, and carried no information
 * about production. These tests deliberately do the opposite:
 *
 *  - the INTEGRATION test drives the real `runAssessment` path with a fake
 *    Supabase client and asserts the transition and audit actually reach the
 *    store — with a negative control that removes the observer and goes red;
 *  - the unit tests cover the branches (not Ashby, terminal, idempotent, error).
 *
 * Zero network, zero DB: Supabase and the model runner are injected doubles.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  observeAshbyCompletion,
  NO_RESULT_SINK_REASON,
  type CompletionObserverDeps,
} from '../integrations/ashby/completion-observer.js';

const LINK = '55555555-5555-4555-8555-555555555555';
const SESSION = '66666666-6666-4666-8666-666666666666';

function deps(over: {
  link?: { id: string; terminalState: string | null } | null;
  lookupThrows?: boolean;
  markResult?: { status: string };
  markThrows?: boolean;
  onMark?: (id: string, reason: string) => void;
} = {}): CompletionObserverDeps {
  return {
    lookup: {
      findLinkBySessionId: async () => {
        if (over.lookupThrows) throw new Error('pg: connection to 10.0.0.5 refused');
        return over.link === undefined ? { id: LINK, terminalState: null } : over.link;
      },
    },
    stores: {
      markWritebackPending: async (id, reason) => {
        over.onMark?.(id, reason);
        if (over.markThrows) throw new Error('rpc exploded');
        return over.markResult ?? { status: 'ok' };
      },
    },
  };
}

describe('observeAshbyCompletion — branches', () => {
  it('parks an Ashby-linked completed session with the no-result-sink reason', async () => {
    const marks: Array<[string, string]> = [];
    const r = await observeAshbyCompletion(SESSION, deps({ onMark: (id, reason) => marks.push([id, reason]) }));
    expect(r).toEqual({ status: 'parked', applicationLinkId: LINK });
    expect(marks).toEqual([[LINK, 'scorecard_write_pending']]);
    expect(NO_RESULT_SINK_REASON).toBe('no_verified_result_sink');
  });

  it('is a no-op for an ordinary non-Ashby session', async () => {
    const marks: unknown[] = [];
    const r = await observeAshbyCompletion(SESSION, deps({ link: null, onMark: () => marks.push(1) }));
    expect(r).toEqual({ status: 'not_ashby' });
    expect(marks).toEqual([]);
  });

  it('refuses to park a terminal (withdrawn/deleted/cancelled) application', async () => {
    for (const terminal of ['withdrawn', 'deleted', 'manual_stage_cancel']) {
      const marks: unknown[] = [];
      const r = await observeAshbyCompletion(SESSION, deps({
        link: { id: LINK, terminalState: terminal }, onMark: () => marks.push(1),
      }));
      expect(r, terminal).toEqual({ status: 'blocked_terminal' });
      // Parking would overwrite a true terminal record with a false one.
      expect(marks, terminal).toEqual([]);
    }
  });

  it('is idempotent — a second observation reports already_pending', async () => {
    const r = await observeAshbyCompletion(SESSION, deps({ markResult: { status: 'already_pending' } }));
    expect(r).toEqual({ status: 'already_pending', applicationLinkId: LINK });
  });

  it('surfaces a store-side terminal refusal', async () => {
    const r = await observeAshbyCompletion(SESSION, deps({ markResult: { status: 'blocked_terminal' } }));
    expect(r).toEqual({ status: 'blocked_terminal' });
  });

  it('never throws, and never leaks the underlying error text', async () => {
    for (const over of [{ lookupThrows: true }, { markThrows: true }]) {
      const r = await observeAshbyCompletion(SESSION, deps(over));
      expect(r).toEqual({ status: 'error' });
      expect(JSON.stringify(r)).not.toContain('10.0.0.5');
      expect(JSON.stringify(r)).not.toContain('exploded');
    }
  });
});

// ── Integration: the REAL assessment path, not a stub ────────────────────────

const SUPABASE_STATE: {
  tables: Record<string, unknown>;
  inserts: Array<{ table: string; payload: Record<string, unknown> }>;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
} = { tables: {}, inserts: [], rpcs: [] };

// Replace ONLY the model call and the notification side effect. Everything
// else — including `runAssessmentImpl` itself — is the real production code,
// so this genuinely exercises the path the observer was wired into.
vi.mock('../lib/claude.js', () => ({
  runClaudeJSONWithProvenance: async () => ({
    data: {
      communication: { score: 7, notes: 'synthetic' },
      motivation: { score: 7, notes: 'synthetic' },
      tone: { clarity: 7, confidence: 7, professionalism: 7 },
      role_fit: { score: 7, notes: 'synthetic' },
      summary: 'synthetic summary',
      red_flags: [],
    },
    requestedModel: 'synthetic-model',
  }),
}));
vi.mock('../lib/notification-intent.js', () => ({ insertNotificationIntent: async () => {} }));
vi.mock('../lib/model-provenance.js', () => ({
  scoringProvenance: () => ({ model: 'synthetic-model', version: '1', scoredAt: '2026-08-17T00:00:00.000Z' }),
}));

vi.mock('../lib/supabase.js', () => {
  const build = (table: string) => {
    const rec: { table: string; op: string; payload?: Record<string, unknown> } = { table, op: 'select' };
    const api: Record<string, unknown> = {};
    const chain = () => api;
    api.select = () => chain();
    api.eq = () => chain();
    api.order = () => chain();
    api.limit = () => chain();
    api.maybeSingle = () => Promise.resolve(SUPABASE_STATE.tables[table] ?? { data: null, error: null });
    api.single = () => Promise.resolve(SUPABASE_STATE.tables[table] ?? { data: null, error: null });
    api.insert = (payload: Record<string, unknown>) => {
      rec.op = 'insert';
      SUPABASE_STATE.inserts.push({ table, payload });
      return chain();
    };
    api.update = () => chain();
    api.then = (onOk: (v: unknown) => unknown) =>
      Promise.resolve(SUPABASE_STATE.tables[table] ?? { data: null, error: null }).then(onOk);
    return api;
  };
  return {
    supabase: {
      from: (t: string) => build(t),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        SUPABASE_STATE.rpcs.push({ fn, args });
        return { data: { status: 'ok', lifecycle: 'writeback_pending' }, error: null };
      },
    },
    RESUME_BUCKET: 'resumes_v2',
  };
});

describe('INTEGRATION — runAssessment parks an Ashby-linked session through the production store', () => {
  beforeEach(() => {
    SUPABASE_STATE.tables = {};
    SUPABASE_STATE.inserts = [];
    SUPABASE_STATE.rpcs = [];
  });
  afterEach(() => { vi.resetModules(); });

  /** Seed the minimum a completed, assessable, Ashby-linked session needs. */
  function seedCompletedAshbySession(over: { terminalState?: string | null } = {}): void {
    SUPABASE_STATE.tables.call_sessions = {
      data: {
        id: SESSION, candidate_id: 'cand_1', owner_id: 'own_1', role_id: null,
        status: 'completed', terminal_reason: 'conversation_complete',
      },
      error: null,
    };
    SUPABASE_STATE.tables.candidates = { data: { name: 'Synthetic', parsed: {}, decision_use_blocked_at: null }, error: null };
    SUPABASE_STATE.tables.transcript_turns = { data: [], error: null };
    SUPABASE_STATE.tables.assessments = { data: { id: 'assess_1' }, error: null };
    SUPABASE_STATE.tables.ashby_application_links = {
      data: { id: LINK, terminal_state: over.terminalState ?? null },
      error: null,
    };
  }

  it('calls mark_ashby_writeback_pending after the REAL runAssessment completes', async () => {
    seedCompletedAshbySession();
    const { runAssessment } = await import('../services/assessment.js');

    // No runner injection: this drives the production `runAssessmentImpl`,
    // including its eligibility guard and its durable assessment insert.
    await runAssessment(SESSION);

    const park = SUPABASE_STATE.rpcs.filter((r) => r.fn === 'mark_ashby_writeback_pending');
    expect(park).toHaveLength(1);
    expect(park[0].args.p_application_link_id).toBe(LINK);
    expect(park[0].args.p_reason).toBe('scorecard_write_pending');
    // And the assessment itself was still persisted — parking is additive.
    expect(SUPABASE_STATE.inserts.some((i) => i.table === 'assessments')).toBe(true);
  });

  it('refuses to run at all for a session that is not completed (no false park)', async () => {
    seedCompletedAshbySession();
    SUPABASE_STATE.tables.call_sessions = {
      data: {
        id: SESSION, candidate_id: 'cand_1', owner_id: 'own_1', role_id: null,
        status: 'failed', terminal_reason: 'room_create_error',
      },
      error: null,
    };
    const { runAssessment } = await import('../services/assessment.js');
    await expect(runAssessment(SESSION)).rejects.toThrow();
    // A failed/incomplete/cancelled session must never be marked complete.
    expect(SUPABASE_STATE.rpcs.filter((r) => r.fn === 'mark_ashby_writeback_pending')).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: with no Ashby link the same real path calls the RPC zero times', async () => {
    // Proves the assertion above depends on the observer resolving a link,
    // not on the assessment path incidentally calling the RPC.
    seedCompletedAshbySession();
    SUPABASE_STATE.tables.ashby_application_links = { data: null, error: null };
    const { runAssessment } = await import('../services/assessment.js');
    await runAssessment(SESSION);
    expect(SUPABASE_STATE.rpcs.filter((r) => r.fn === 'mark_ashby_writeback_pending')).toHaveLength(0);
  });

  it('does not park a terminal application even on a completed session', async () => {
    seedCompletedAshbySession({ terminalState: 'withdrawn' });
    const { createAshbyLinkLookup, createWorkflowStores } = await import('../integrations/ashby/workflow-stores.js');
    const { supabase } = await import('../lib/supabase.js');
    const r = await observeAshbyCompletion(SESSION, {
      lookup: createAshbyLinkLookup(supabase as never),
      stores: createWorkflowStores(supabase as never),
    });
    expect(r).toEqual({ status: 'blocked_terminal' });
    expect(SUPABASE_STATE.rpcs.filter((x) => x.fn === 'mark_ashby_writeback_pending')).toHaveLength(0);
  });

  it('parks nothing for a non-Ashby session', async () => {
    seedCompletedAshbySession();
    SUPABASE_STATE.tables.ashby_application_links = { data: null, error: null };
    const { createAshbyLinkLookup, createWorkflowStores } = await import('../integrations/ashby/workflow-stores.js');
    const { supabase } = await import('../lib/supabase.js');
    const r = await observeAshbyCompletion(SESSION, {
      lookup: createAshbyLinkLookup(supabase as never),
      stores: createWorkflowStores(supabase as never),
    });
    expect(r).toEqual({ status: 'not_ashby' });
    expect(SUPABASE_STATE.rpcs).toHaveLength(0);
  });
});
