/**
 * The Christy tag at the two seams around the lane: the completion observer that
 * asks for the operation, and the store adapters that talk to Supabase.
 *
 * The observer's one rule: a tag problem can never change its outcome or touch
 * the scorecard path. The store's one rule: the verdict is the RAW column, because
 * every other reader coerces a missing verdict to `hold`.
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
 * Chainable Supabase double. `assessments` is read twice (the row, then the
 * tolerant evidence grade); `select` picks which answer a read gets.
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
  data: { external_application_id: 'app-1', external_candidate_id: 'cand-1', session_id: 'session-from-link' },
  error: null,
};
const NEWEST_OP: TableResult = { data: { id: 'op-newest' }, error: null };

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

describe('createWorkflowStores: readRecommendationTagSource', () => {
  const read = (results: Record<string, TableResult>, session: string | null = 'session-1') => {
    const fake = fakeClient({ ashby_application_links: LINK_ROW, ashby_operations: NEWEST_OP, ...results });
    return { fake, result: createWorkflowStores(fake.client as never).readRecommendationTagSource!('link-1', session) };
  };

  it.each(['advance', 'hold', 'reject'])('returns the raw column: %s', async (recommendation) => {
    const { result } = read({ assessments: { data: { id: 'a-1', recommendation }, error: null } });
    expect(await result).toMatchObject({
      recommendation,
      externalCandidateId: 'cand-1',
      externalApplicationId: 'app-1',
      evidenceGrade: null,
    });
  });

  it('a NULL verdict stays NULL: it is never coerced to hold', async () => {
    const { result } = read({ assessments: { data: { id: 'a-1', recommendation: null }, error: null } });
    expect((await result)?.recommendation).toBeNull();
  });

  it('selects only the id and the raw verdict: it reads no scoring_status and no scorecard columns', async () => {
    const { fake, result } = read({ assessments: { data: { id: 'a-1', recommendation: 'reject' }, error: null } });
    await result;
    expect(fake.selects.find((s) => s.table === 'assessments')?.columns).toBe('id, recommendation');
  });

  it('carries the evidence grade', async () => {
    const { result } = read({
      assessments: { data: { id: 'a-1', recommendation: 'advance' }, error: null },
      assessments_grade: { data: { evidence_grade: 'insufficient' }, error: null },
    });
    expect((await result)?.evidenceGrade).toBe('insufficient');
  });

  it('orders the assessment and the operation by created_at desc, id desc', async () => {
    const { fake, result } = read({ assessments: { data: { id: 'a-1', recommendation: 'advance' }, error: null } });
    await result;
    for (const table of ['assessments', 'ashby_operations']) {
      expect(fake.orders.filter((o) => o.table === table)).toEqual([
        { table, column: 'created_at', ascending: false },
        { table, column: 'id', ascending: false },
      ]);
    }
  });

  it('answers whether an operation is the newest on the link', async () => {
    const { result } = read({ assessments: { data: { id: 'a-1', recommendation: 'advance' }, error: null } });
    const source = await result;
    expect(source?.isNewestTagOperation('op-newest')).toBe(true);
    expect(source?.isNewestTagOperation('op-older')).toBe(false);
  });

  it('falls back to the link session when the operation has none', async () => {
    const { result } = read({ assessments: { data: { id: 'a-1', recommendation: 'advance' }, error: null } }, null);
    expect(await result).not.toBeNull();
  });

  it.each([
    ['the link read fails', { ashby_application_links: { data: null, error: { message: 'x' } } }],
    ['the link is gone', { ashby_application_links: { data: null, error: null } }],
    ['the assessment read fails', { assessments: { data: null, error: { message: 'x' } } }],
    ['there is no assessment', { assessments: { data: null, error: null } }],
    ['the grade read fails', {
      assessments: { data: { id: 'a-1', recommendation: 'advance' }, error: null },
      assessments_grade: { data: null, error: { code: 'XX000', message: 'boom' } },
    }],
    ['the newest-operation read fails', {
      assessments: { data: { id: 'a-1', recommendation: 'advance' }, error: null },
      ashby_operations: { data: null, error: { message: 'x' } },
    }],
  ])('%s: null, which the lane fails as retryable assessment_missing', async (_label, results) => {
    const { result } = read(results);
    expect(await result).toBeNull();
  });

  it('no session anywhere: null', async () => {
    const fake = fakeClient({
      ashby_application_links: { data: { external_application_id: 'a', external_candidate_id: null, session_id: null }, error: null },
    });
    const r = await createWorkflowStores(fake.client as never).readRecommendationTagSource!('link-1', null);
    expect(r).toBeNull();
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
