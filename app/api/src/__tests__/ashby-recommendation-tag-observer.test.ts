/**
 * The Christy tag at the two seams around the lane: the completion observer that
 * asks for the operation, and the store adapters that talk to Supabase.
 *
 * The observer's one rule: a tag problem can never change its outcome or touch
 * the scorecard path. The store's rules: the verdict is the database's
 * candidate-wide answer (0134 `ashby_candidate_tag_verdict`), and it is the RAW
 * column, because every other reader coerces a missing verdict to `hold`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeAshbyCompletion, type CompletionStore } from '../integrations/ashby/completion-observer.js';
import { createWorkflowStores } from '../integrations/ashby/workflow-stores.js';

const SESSION = 'session-1';
const LINK = { id: 'link-1', terminalState: null };

function observerDeps(store: CompletionStore, link: { id: string; terminalState: string | null } | null = LINK) {
  return { lookup: { findLinkBySessionId: async () => link }, stores: store };
}

function store(over: Partial<CompletionStore> = {}) {
  return {
    markWritebackPending: vi.fn(async () => ({ status: 'ok' })),
    enqueueScorecardWrite: vi.fn(async () => ({ status: 'inserted' })),
    enqueueRecommendationTag: vi.fn(async () => ({ status: 'inserted' })),
    ...over,
  };
}

describe('observeAshbyCompletion: the tag operation', () => {
  it('normal branch: enqueues the scorecard, then the tag, for this link and session', async () => {
    const order: string[] = [];
    const s = store({
      enqueueScorecardWrite: vi.fn(async () => { order.push('scorecard'); return { status: 'inserted' }; }),
      enqueueRecommendationTag: vi.fn(async () => { order.push('tag'); return { status: 'inserted' }; }),
    });
    const r = await observeAshbyCompletion(SESSION, observerDeps(s));
    expect(r).toEqual({ status: 'parked', applicationLinkId: 'link-1' });
    expect(order).toEqual(['scorecard', 'tag']);
    expect(s.enqueueRecommendationTag).toHaveBeenCalledWith('link-1', SESSION);
  });

  it('normal branch: also on already_pending, which is how a rescore arrives', async () => {
    const s = store({ markWritebackPending: vi.fn(async () => ({ status: 'already_pending' })) });
    const r = await observeAshbyCompletion(SESSION, observerDeps(s));
    expect(r).toEqual({ status: 'already_pending', applicationLinkId: 'link-1' });
    expect(s.enqueueRecommendationTag).toHaveBeenCalledTimes(1);
  });

  it('insufficient evidence: no scorecard, but the tag is enqueued so a stale one can come off', async () => {
    const s = store();
    const r = await observeAshbyCompletion(SESSION, observerDeps(s), { evidenceGrade: 'insufficient' });
    expect(r).toEqual({ status: 'held_insufficient_evidence', applicationLinkId: 'link-1' });
    expect(s.enqueueScorecardWrite).not.toHaveBeenCalled();
    expect(s.enqueueRecommendationTag).toHaveBeenCalledWith('link-1', SESSION);
  });

  it('insufficient evidence: a hold mark that failed enqueues nothing', async () => {
    const s = store({ markWritebackPending: vi.fn(async () => ({ status: 'error' })) });
    const r = await observeAshbyCompletion(SESSION, observerDeps(s), { evidenceGrade: 'insufficient' });
    expect(r).toEqual({ status: 'error' });
    expect(s.enqueueRecommendationTag).not.toHaveBeenCalled();
  });

  it.each([
    ['normal', {}, 'parked'],
    ['insufficient evidence', { evidenceGrade: 'insufficient' as const }, 'held_insufficient_evidence'],
  ])('%s: a tag throw does not change the outcome', async (_label, options, status) => {
    const s = store({ enqueueRecommendationTag: vi.fn(async () => { throw new Error('rpc down'); }) });
    const r = await observeAshbyCompletion(SESSION, observerDeps(s), options);
    expect(r).toMatchObject({ status, applicationLinkId: 'link-1' });
  });

  it('a tag throw does not disturb the scorecard', async () => {
    const s = store({ enqueueRecommendationTag: vi.fn(async () => { throw new Error('rpc down'); }) });
    await observeAshbyCompletion(SESSION, observerDeps(s));
    expect(s.enqueueScorecardWrite).toHaveBeenCalledTimes(1);
  });

  it('a scorecard throw still attempts the tag, and the outcome stays what it always was', async () => {
    const s = store({ enqueueScorecardWrite: vi.fn(async () => { throw new Error('rpc down'); }) });
    const r = await observeAshbyCompletion(SESSION, observerDeps(s));
    expect(r).toEqual({ status: 'error' });
    expect(s.enqueueRecommendationTag).toHaveBeenCalledWith('link-1', SESSION);
  });

  it('a terminal link enqueues nothing', async () => {
    const s = store();
    const r = await observeAshbyCompletion(SESSION, observerDeps(s, { id: 'link-1', terminalState: 'withdrawn' }));
    expect(r).toEqual({ status: 'blocked_terminal' });
    expect(s.enqueueRecommendationTag).not.toHaveBeenCalled();
  });

  it('a terminal answer from the park enqueues nothing', async () => {
    const s = store({ markWritebackPending: vi.fn(async () => ({ status: 'blocked_terminal' })) });
    const r = await observeAshbyCompletion(SESSION, observerDeps(s));
    expect(r).toEqual({ status: 'blocked_terminal' });
    expect(s.enqueueRecommendationTag).not.toHaveBeenCalled();
  });

  it('a non-Ashby session enqueues nothing', async () => {
    const s = store();
    const r = await observeAshbyCompletion(SESSION, observerDeps(s, null));
    expect(r).toEqual({ status: 'not_ashby' });
    expect(s.enqueueRecommendationTag).not.toHaveBeenCalled();
  });

  it('a store without the method keeps the old behaviour', async () => {
    const r = await observeAshbyCompletion(SESSION, observerDeps({
      markWritebackPending: async () => ({ status: 'ok' }),
    }));
    expect(r).toEqual({ status: 'parked', applicationLinkId: 'link-1' });
  });
});

// ── Store adapters ──────────────────────────────────────────────────────────

interface TableResult { data: unknown; error: unknown }

/**
 * Chainable Supabase double. A table read answers `results[table]`; every RPC
 * answers `rpcResult`. `selects` and `orders` record what was asked.
 */
function fakeClient(results: Record<string, TableResult>, rpcResult: TableResult = { data: { status: 'inserted', id: 'op-1' }, error: null }) {
  const selects: Array<{ table: string; columns: string }> = [];
  const orders: Array<{ table: string; column: string; ascending: unknown }> = [];
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => rpcResult);
  const client = {
    from(table: string) {
      let columns = '';
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['eq', 'limit', 'in', 'is']) builder[m] = chain;
      builder.select = (c: string) => { columns = c; selects.push({ table, columns: c }); return builder; };
      builder.order = (column: string, opts: { ascending?: unknown }) => {
        orders.push({ table, column, ascending: opts?.ascending });
        return builder;
      };
      builder.maybeSingle = async () => {
        if (table === 'assessments' && columns === 'evidence_grade') {
          return results.assessments_grade ?? { data: { evidence_grade: null }, error: null };
        }
        return results[table] ?? { data: null, error: null };
      };
      return builder;
    },
    rpc,
  };
  return { client, rpc, selects, orders };
}

const LINK_ROW: TableResult = {
  data: { external_application_id: 'app-1', external_candidate_id: 'cand-1' },
  error: null,
};

describe('createWorkflowStores: enqueueRecommendationTag', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('calls the RPC with the link, session and system actor while the switch is on', async () => {
    vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', 'true');
    const { client, rpc } = fakeClient({});
    const r = await createWorkflowStores(client as never).enqueueRecommendationTag!('link-1', 'session-1');
    expect(r).toEqual({ status: 'inserted' });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe('enqueue_ashby_recommendation_tag');
    expect(args).toMatchObject({
      p_application_link_id: 'link-1',
      p_session_id: 'session-1',
      p_actor_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(Object.keys(args).sort()).toEqual(['p_actor_id', 'p_application_link_id', 'p_now', 'p_session_id']);
  });

  it.each([undefined, 'false', 'TRUE', '1'])('the switch at %s answers disabled with no call', async (value) => {
    if (value === undefined) vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', undefined as unknown as string);
    else vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', value);
    const { client, rpc } = fakeClient({});
    const r = await createWorkflowStores(client as never).enqueueRecommendationTag!('link-1', 'session-1');
    expect(r).toEqual({ status: 'disabled' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('an RPC error throws a fixed code, never the database text', async () => {
    vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', 'true');
    const { client } = fakeClient({}, { data: null, error: { message: 'secret row detail' } });
    await expect(createWorkflowStores(client as never).enqueueRecommendationTag!('l', 's'))
      .rejects.toThrow(/^ashby_recommendation_tag_enqueue_error$/);
  });
});

describe('createWorkflowStores: readRecommendationTagLink', () => {
  it('reads only the two Ashby ids of the Ashby link', async () => {
    const fake = fakeClient({ ashby_application_links: LINK_ROW });
    const r = await createWorkflowStores(fake.client as never).readRecommendationTagLink!('link-1');
    expect(r).toEqual({ externalCandidateId: 'cand-1', externalApplicationId: 'app-1' });
    expect(fake.selects).toEqual([
      { table: 'ashby_application_links', columns: 'external_application_id, external_candidate_id' },
    ]);
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('a missing or empty id is null, so the lane falls back to application.info', async () => {
    const fake = fakeClient({
      ashby_application_links: { data: { external_application_id: 'app-1', external_candidate_id: '' }, error: null },
    });
    const r = await createWorkflowStores(fake.client as never).readRecommendationTagLink!('link-1');
    expect(r).toEqual({ externalCandidateId: null, externalApplicationId: 'app-1' });
  });

  it.each([
    ['the read fails', { data: null, error: { message: 'secret row detail' } }],
    ['the link is gone', { data: null, error: null }],
  ])('%s: null, which the lane waits on', async (_label, row) => {
    const fake = fakeClient({ ashby_application_links: row });
    expect(await createWorkflowStores(fake.client as never).readRecommendationTagLink!('link-1')).toBeNull();
  });
});

describe('createWorkflowStores: readRecommendationTagSource', () => {
  const read = (rpcResult: TableResult, candidate: string | null = 'cand-1') => {
    const fake = fakeClient({}, rpcResult);
    return { fake, result: createWorkflowStores(fake.client as never).readRecommendationTagSource!('link-1', candidate) };
  };
  const ok = (extra: Record<string, unknown>): TableResult => ({
    data: {
      status: 'ok', assessment_id: 'a-1', recommendation: 'advance', evidence_grade: 'decision',
      assessment_created_at: '2026-11-04T00:00:00+00:00', link_count: 2, session_count: 3, ...extra,
    },
    error: null,
  });

  it('asks the 0134 RPC for the candidate verdict, with the link and the Ashby candidate id only', async () => {
    const { fake, result } = read(ok({}));
    await result;
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = fake.rpc.mock.calls[0];
    expect(name).toBe('ashby_candidate_tag_verdict');
    expect(args).toEqual({ p_application_link_id: 'link-1', p_external_candidate_id: 'cand-1' });
    // The decision is the database's: no table is read here.
    expect(fake.selects).toEqual([]);
  });

  it('passes a null candidate id through', async () => {
    const { fake, result } = read(ok({}), null);
    await result;
    expect(fake.rpc.mock.calls[0][1]).toEqual({ p_application_link_id: 'link-1', p_external_candidate_id: null });
  });

  it.each(['advance', 'hold', 'reject'])('returns the raw verdict: %s', async (recommendation) => {
    const { result } = read(ok({ recommendation }));
    expect(await result).toEqual({ status: 'ok', recommendation, evidenceGrade: 'decision' });
  });

  it('a NULL verdict stays NULL: it is never coerced to hold', async () => {
    const { result } = read(ok({ recommendation: null }));
    expect(await result).toEqual({ status: 'ok', recommendation: null, evidenceGrade: 'decision' });
  });

  it('carries the evidence grade, and only a known one', async () => {
    expect((await read(ok({ evidence_grade: 'insufficient' })).result)?.evidenceGrade).toBe('insufficient');
    expect((await read(ok({ evidence_grade: null })).result)?.evidenceGrade).toBeNull();
    expect((await read(ok({ evidence_grade: 'bogus' })).result)?.evidenceGrade).toBeNull();
  });

  it('no_assessment is an answer, not a failure: the target is no tag', async () => {
    const { result } = read({ data: { status: 'no_assessment', link_count: 1, session_count: 0 }, error: null });
    expect(await result).toEqual({ status: 'no_assessment', recommendation: null, evidenceGrade: null });
  });

  it.each([
    ['the RPC fails', { data: null, error: { message: 'secret row detail' } }],
    ['the RPC answers nothing', { data: null, error: null }],
    ['the link is gone', { data: { status: 'not_found' }, error: null }],
    ['the request is refused', { data: { status: 'invalid_request' }, error: null }],
    ['an unknown status', { data: { status: 'maybe' }, error: null }],
    ['a non-object answer', { data: 'ok', error: null }],
  ])('%s: null, which the lane waits on', async (_label, rpcResult) => {
    expect(await read(rpcResult).result).toBeNull();
  });
});

describe('createWorkflowStores: claimOperation parses created_at', () => {
  const claimed = (extra: Record<string, unknown>) => ({
    data: {
      status: 'claimed', id: 'op-1', operation_type: 'recommendation_tag', application_link_id: 'link-1',
      lease_token: 'lease-1', attempts: 1, max_attempts: 5, marker: null, ...extra,
    },
    error: null,
  });

  it('carries the timestamp and the session through', async () => {
    const { client } = fakeClient({}, claimed({ created_at: '2026-11-04T00:00:00Z', source_session_id: 'session-1' }));
    const r = await createWorkflowStores(client as never).claimOperation('recommendation_tag', 'w1', 30);
    expect(r).toMatchObject({ operationType: 'recommendation_tag', createdAt: '2026-11-04T00:00:00Z', sourceSessionId: 'session-1' });
  });

  it('a claim from an older database has no timestamp: null, not a crash', async () => {
    const { client } = fakeClient({}, claimed({}));
    const r = await createWorkflowStores(client as never).claimOperation('recommendation_tag', 'w1', 30);
    expect(r?.createdAt).toBeNull();
  });
});
