/**
 * The Christy verdict tag: client helpers, the pure verdict map, the tag id
 * resolver and every branch of the lane executor. Zero network, zero DB. The
 * documented envelopes through a real client are in
 * ashby-recommendation-tag-contract.test.ts; the whole flow is in
 * ashby-recommendation-tag-simulation.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { AshbyClient, type AshbyTransport, type AshbyTransportRequest, type AshbyTransportResponse } from '../integrations/ashby/client.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import { PROBE_READ_OPERATIONS } from '../integrations/ashby/probe.js';
import { ASHBY_OPERATIONS } from '../integrations/ashby/types.js';
import {
  CHRISTY_TAG_CACHE_MS,
  CHRISTY_VERDICT_TAG_TITLES,
  TAG_CONFIG_FAULT_DEFER_SECONDS,
  TAG_DEFER_AGE_LIMIT_MS,
  TAG_TRANSIENT_DEFER_SECONDS,
  christyTagForVerdict,
  createChristyTagResolver,
  executeRecommendationTag,
  recommendationTagsEnabled,
  type RecommendationTagClient,
  type RecommendationTagDeps,
} from '../integrations/ashby/recommendation-tags.js';
import {
  REFUSED_OPERATION_TYPES,
  runAshbyOperationPass,
  runClaimedAshbyOperation,
} from '../integrations/ashby/operation-worker.js';
import type {
  OperationClaimRow,
  RecommendationTagSource,
  RuntimeWorkflowStores,
  WorkflowLinkRow,
} from '../integrations/ashby/orchestration.js';

const CAND = 'cand-1';
const NOW = Date.parse('2026-11-04T00:00:00.000Z');
const SELECT = { id: 'tag-select', title: CHRISTY_VERDICT_TAG_TITLES.select, isArchived: false };
const BORDERLINE = { id: 'tag-borderline', title: CHRISTY_VERDICT_TAG_TITLES.borderline, isArchived: false };
const REJECT = { id: 'tag-reject', title: CHRISTY_VERDICT_TAG_TITLES.reject, isArchived: false };
const CATALOGUE = [SELECT, BORDERLINE, REJECT, { id: 'tag-vip', title: 'VIP', isArchived: false }];

// ── Client helpers ──────────────────────────────────────────────────────────

function res(status: number, body: string): AshbyTransportResponse {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => body };
}
const okEnvelope = (results: unknown = {}) => res(200, JSON.stringify({ success: true, results }));

function clientWith(steps: Array<AshbyTransportResponse | Error>) {
  const calls: AshbyTransportRequest[] = [];
  let i = 0;
  const transport: AshbyTransport = async (req) => {
    calls.push(req);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return step;
  };
  const client = new AshbyClient({
    apiKey: 'synthetic-key',
    transport,
    random: () => 0.5,
    sleep: async () => {},
  });
  return { client, calls };
}

describe('registry', () => {
  it('adds the two writes as mutations and the list as a read', () => {
    expect(ASHBY_OPERATIONS['candidate.addTag']).toEqual({ path: '/candidate.addTag', mutation: true });
    expect(ASHBY_OPERATIONS['candidate.removeTag']).toEqual({ path: '/candidate.removeTag', mutation: true });
    expect(ASHBY_OPERATIONS['candidateTag.list']).toEqual({ path: '/candidateTag.list', mutation: false });
  });

  it('does not widen the probe: none of them is a probe read', () => {
    for (const op of ['candidate.addTag', 'candidate.removeTag', 'candidateTag.list']) {
      expect(PROBE_READ_OPERATIONS as readonly string[]).not.toContain(op);
    }
  });
});

describe('AshbyClient tag helpers', () => {
  it.each([
    ['candidateAddTag', '/candidate.addTag'],
    ['candidateRemoveTag', '/candidate.removeTag'],
  ] as const)('%s sends exactly {candidateId, tagId}', async (method, path) => {
    const { client, calls } = clientWith([okEnvelope()]);
    await client[method](CAND, 'tag-1');
    expect(new URL(calls[0].url).pathname).toBe(path);
    expect(JSON.parse(calls[0].body)).toEqual({ candidateId: CAND, tagId: 'tag-1' });
  });

  it.each(['candidateAddTag', 'candidateRemoveTag'] as const)(
    '%s refuses a bad id before the transport',
    async (method) => {
      const { client, calls } = clientWith([okEnvelope()]);
      await expect(client[method]('', 'tag-1')).rejects.toMatchObject({ category: 'invalid_request' });
      await expect(client[method](CAND, 'x'.repeat(300))).rejects.toMatchObject({ category: 'invalid_request' });
      await expect(client[method](CAND, 'a\nb')).rejects.toMatchObject({ category: 'invalid_request' });
      expect(calls).toHaveLength(0);
    },
  );

  it.each(['candidateAddTag', 'candidateRemoveTag'] as const)(
    '%s retries an ambiguous network failure, because the lane reads before it writes',
    async (method) => {
      const { client, calls } = clientWith([new Error('socket hang up'), okEnvelope()]);
      await expect(client[method](CAND, 'tag-1')).resolves.toBeDefined();
      expect(calls).toHaveLength(2);
    },
  );

  it('CONTROL: an ordinary mutation still fails closed on the same failure', async () => {
    const { client, calls } = clientWith([new Error('socket hang up'), okEnvelope()]);
    await expect(client.applicationChangeStage('a', 's')).rejects.toMatchObject({ category: 'network', retriable: false });
    expect(calls).toHaveLength(1);
  });

  it('never retries a logical failure', async () => {
    const { client, calls } = clientWith([
      res(200, JSON.stringify({ success: false, errorInfo: { code: 'tag_not_valid' } })),
      okEnvelope(),
    ]);
    await expect(client.candidateAddTag(CAND, 'tag-1')).rejects.toMatchObject({
      category: 'logical_failure',
      endpointCodes: ['tag_not_valid'],
    });
    expect(calls).toHaveLength(1);
  });

  it('candidateTagList always sends includeArchived:false', async () => {
    const { client, calls } = clientWith([okEnvelope([])]);
    await client.candidateTagList();
    expect(new URL(calls[0].url).pathname).toBe('/candidateTag.list');
    expect(JSON.parse(calls[0].body)).toEqual({ includeArchived: false });
  });

  it('candidateTagList passes the cursor through unchanged', async () => {
    const { client, calls } = clientWith([okEnvelope([])]);
    await client.candidateTagList({ cursor: 'opaque==', limit: 50 });
    expect(JSON.parse(calls[0].body)).toEqual({ includeArchived: false, cursor: 'opaque==', limit: 50 });
  });

  it('candidateTagList bounds limit to 1..100', async () => {
    const { client, calls } = clientWith([okEnvelope([])]);
    await client.candidateTagList({ limit: 500 });
    await client.candidateTagList({ limit: 0 });
    expect(JSON.parse(calls[0].body).limit).toBe(100);
    expect(JSON.parse(calls[1].body).limit).toBe(1);
    await expect(client.candidateTagList({ limit: 1.5 })).rejects.toMatchObject({ code: 'invalid_limit' });
    expect(calls).toHaveLength(2);
  });
});

// ── Verdict map and kill switch ─────────────────────────────────────────────

describe('christyTagForVerdict', () => {
  it.each([
    ['advance', 'select'],
    ['hold', 'borderline'],
    ['reject', 'reject'],
  ] as const)('%s -> %s', (recommendation, tag) => {
    expect(christyTagForVerdict({ recommendation, evidenceGrade: 'decision' })).toBe(tag);
    expect(christyTagForVerdict({ recommendation, evidenceGrade: null })).toBe(tag);
  });

  it.each([null, undefined, 'human_review', '', 'Advance', 'select', 1])('no verdict: %s -> null', (recommendation) => {
    expect(christyTagForVerdict({ recommendation })).toBeNull();
  });

  it.each(['advance', 'hold', 'reject'])('insufficient evidence wins over %s', (recommendation) => {
    expect(christyTagForVerdict({ recommendation, evidenceGrade: 'insufficient' })).toBeNull();
  });

  it('pins the exact titles the admin created', () => {
    expect(CHRISTY_VERDICT_TAG_TITLES).toEqual({
      select: 'Christy: Select',
      borderline: 'Christy: Borderline',
      reject: 'Christy: Reject',
    });
  });
});

describe('recommendationTagsEnabled', () => {
  it.each([
    ['true', true],
    ['TRUE', false],
    ['1', false],
    ['false', false],
    ['', false],
  ])('%j -> %s', (value, expected) => {
    vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', value);
    expect(recommendationTagsEnabled()).toBe(expected);
    vi.unstubAllEnvs();
  });
});

// ── Resolver ────────────────────────────────────────────────────────────────

function pages(...list: Array<{ results: unknown; moreDataAvailable?: boolean; nextCursor?: string }>) {
  let i = 0;
  return vi.fn(async (_params?: { cursor?: string; limit?: number }) => {
    const page = list[Math.min(i, list.length - 1)];
    i += 1;
    return { moreDataAvailable: false, ...page };
  });
}

describe('createChristyTagResolver', () => {
  it('finds a title on a later page, walking every cursor unchanged', async () => {
    const candidateTagList = pages(
      { results: [{ id: 'tag-vip', title: 'VIP', isArchived: false }], moreDataAvailable: true, nextCursor: 'c1' },
      { results: [SELECT], moreDataAvailable: false },
    );
    const r = createChristyTagResolver({ candidateTagList });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select' });
    expect(candidateTagList.mock.calls.map((c) => c[0]?.cursor)).toEqual([undefined, 'c1']);
    expect(candidateTagList.mock.calls[0][0]?.limit).toBe(100);
  });

  it('tolerates an empty page while more data follows', async () => {
    const r = createChristyTagResolver({
      candidateTagList: pages(
        { results: [], moreDataAvailable: true, nextCursor: 'c1' },
        { results: [REJECT] },
      ),
    });
    expect(await r.resolve('Christy: Reject')).toEqual({ status: 'found', tagId: 'tag-reject' });
  });

  it('fails closed as truncated when more data is promised with no cursor', async () => {
    const r = createChristyTagResolver({
      candidateTagList: pages({ results: [SELECT], moreDataAvailable: true }),
    });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'truncated' });
  });

  it('fails closed as truncated on a repeating cursor, and terminates', async () => {
    const candidateTagList = pages(
      { results: [], moreDataAvailable: true, nextCursor: 'c1' },
      { results: [], moreDataAvailable: true, nextCursor: 'c1' },
    );
    const r = createChristyTagResolver({ candidateTagList });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'truncated' });
    expect(candidateTagList).toHaveBeenCalledTimes(2);
  });

  it('fails closed as truncated when the result is not a list', async () => {
    const r = createChristyTagResolver({ candidateTagList: pages({ results: { nope: true } }) });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'truncated' });
  });

  it('ignores an archived tag, and one that does not say it is active', async () => {
    const r = createChristyTagResolver({
      candidateTagList: pages({
        results: [
          { id: 'old', title: 'Christy: Select', isArchived: true },
          { id: 'unknown', title: 'Christy: Select' },
        ],
      }),
    });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'not_found' });
  });

  it('an archived twin does not make an active tag ambiguous', async () => {
    const r = createChristyTagResolver({
      candidateTagList: pages({ results: [{ id: 'old', title: 'Christy: Select', isArchived: true }, SELECT] }),
    });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select' });
  });

  it('two active matches are ambiguous', async () => {
    const r = createChristyTagResolver({
      candidateTagList: pages({ results: [SELECT, { id: 'twin', title: ' Christy: Select ', isArchived: false }] }),
    });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'ambiguous' });
  });

  it('the same id seen on two pages is one tag, not ambiguous', async () => {
    const r = createChristyTagResolver({
      candidateTagList: pages(
        { results: [SELECT], moreDataAvailable: true, nextCursor: 'c1' },
        { results: [SELECT] },
      ),
    });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select' });
  });

  it('trims, then matches exactly and case-sensitively', async () => {
    const trimmed = createChristyTagResolver({
      candidateTagList: pages({ results: [{ id: 'spaced', title: '  Christy: Reject ', isArchived: false }] }),
    });
    expect(await trimmed.resolve('Christy: Reject')).toEqual({ status: 'found', tagId: 'spaced' });

    const near = createChristyTagResolver({
      candidateTagList: pages({
        results: [
          { id: 'a', title: 'christy: reject', isArchived: false },
          { id: 'b', title: 'Christy:Reject', isArchived: false },
          { id: 'c', title: 'Christy: Rejected', isArchived: false },
        ],
      }),
    });
    expect(await near.resolve('Christy: Reject')).toEqual({ status: 'not_found' });
  });

  it('caches a complete read for five minutes, then reads again', async () => {
    let now = NOW;
    const candidateTagList = pages({ results: CATALOGUE });
    const r = createChristyTagResolver({ candidateTagList }, () => now);
    await r.resolve('Christy: Select');
    await r.resolve('Christy: Reject');
    now += CHRISTY_TAG_CACHE_MS - 1;
    await r.resolve('Christy: Borderline');
    expect(candidateTagList).toHaveBeenCalledTimes(1);
    now += 1;
    await r.resolve('Christy: Select');
    expect(candidateTagList).toHaveBeenCalledTimes(2);
  });

  it('fresh bypasses the cache and refreshes it', async () => {
    const candidateTagList = pages({ results: [] }, { results: [SELECT] });
    const r = createChristyTagResolver({ candidateTagList });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'not_found' });
    expect(await r.resolve('Christy: Select', { fresh: true })).toEqual({ status: 'found', tagId: 'tag-select' });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select' });
    expect(candidateTagList).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure or a truncated read', async () => {
    const candidateTagList = vi
      .fn()
      .mockRejectedValueOnce(new AshbyError('http_client_error', { httpStatus: 403 }))
      .mockResolvedValueOnce({ results: [SELECT], moreDataAvailable: true })
      .mockResolvedValueOnce({ results: [SELECT], moreDataAvailable: false });
    const r = createChristyTagResolver({ candidateTagList });
    await expect(r.resolve('Christy: Select')).rejects.toBeInstanceOf(AshbyError);
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'truncated' });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select' });
    expect(candidateTagList).toHaveBeenCalledTimes(3);
  });

  it('holds only the three titles, nothing else of the tenant', async () => {
    const candidateTagList = pages({ results: [{ id: 'tag-vip', title: 'VIP', isArchived: false }] });
    const r = createChristyTagResolver({ candidateTagList });
    // @ts-expect-error a title outside the three is not even expressible
    expect(await r.resolve('VIP')).toEqual({ status: 'not_found' });
  });
});

// ── Lane executor ───────────────────────────────────────────────────────────

const claim: OperationClaimRow = {
  id: 'op-1',
  operationType: 'recommendation_tag',
  operationKey: 'ashby:recommendation_tag:link-1:assessment-1',
  applicationLinkId: 'link-1',
  leaseToken: 'lease-1',
  attempts: 1,
  maxAttempts: 5,
  marker: null,
  sourceSessionId: 'session-1',
  createdAt: new Date(NOW - 60_000).toISOString(),
};

function source(over: Partial<RecommendationTagSource> = {}): RecommendationTagSource {
  return {
    externalCandidateId: CAND,
    externalApplicationId: 'app-1',
    recommendation: 'advance',
    evidenceGrade: 'decision',
    isNewestTagOperation: () => true,
    ...over,
  };
}

function harness(opts: {
  tags?: unknown;
  src?: RecommendationTagSource | null;
  catalogue?: unknown[];
  claim?: Partial<OperationClaimRow>;
  client?: Partial<RecommendationTagClient>;
  stores?: Partial<RecommendationTagDeps['stores']>;
  listTags?: ReturnType<typeof vi.fn>;
} = {}) {
  const calls: string[] = [];
  const client: RecommendationTagClient = {
    applicationInfo: vi.fn(async () => ({ results: { id: 'app-1', candidate: { id: CAND } }, moreDataAvailable: false })),
    candidateInfo: vi.fn(async () => ({ results: { id: CAND, tags: opts.tags ?? [] }, moreDataAvailable: false })),
    candidateAddTag: vi.fn(async (_c: string, tagId: string) => { calls.push(`add:${tagId}`); }),
    candidateRemoveTag: vi.fn(async (_c: string, tagId: string) => { calls.push(`remove:${tagId}`); }),
    ...opts.client,
  };
  const candidateTagList = opts.listTags ?? vi.fn(async () => ({ results: opts.catalogue ?? CATALOGUE, moreDataAvailable: false }));
  const stores = {
    completeOperation: vi.fn(async () => 'ok' as const),
    failOperation: vi.fn(async () => ({ outcome: 'retry' as const })),
    deferOperation: vi.fn(async () => 'ok' as const),
    readRecommendationTagSource: vi.fn(async () => (opts.src === undefined ? source() : opts.src)),
    bindLinkExternalCandidateId: vi.fn(async () => {}),
    ...opts.stores,
  };
  const events: Array<{ kind: string; operationType: string; code?: string }> = [];
  const run = () =>
    executeRecommendationTag(
      { ...claim, ...opts.claim },
      {
        stores: stores as unknown as RecommendationTagDeps['stores'],
        adapter: { client, resolver: createChristyTagResolver({ candidateTagList: candidateTagList as never }, () => NOW) },
        nowMs: () => NOW,
        onEvent: (e) => events.push(e),
      },
    );
  return { client, stores, calls, run, events, candidateTagList };
}

const http = (status: number) => new AshbyError('http_client_error', { httpStatus: status });
const logical = (...endpointCodes: string[]) => new AshbyError('logical_failure', { httpStatus: 200, endpointCodes });

describe('executeRecommendationTag: applying a verdict', () => {
  it.each([
    ['advance', 'tag-select', 'christy_tag_select'],
    ['hold', 'tag-borderline', 'christy_tag_borderline'],
    ['reject', 'tag-reject', 'christy_tag_reject'],
  ])('%s adds its tag and completes with the anchor and a NULL marker', async (recommendation, tagId, anchor) => {
    const h = harness({ src: source({ recommendation }) });
    const r = await h.run();
    expect(h.calls).toEqual([`add:${tagId}`]);
    expect(h.stores.completeOperation).toHaveBeenCalledWith('op-1', 'lease-1', anchor, null);
    expect(r).toEqual({ claimed: true, operationType: 'recommendation_tag', committed: true, staleLease: false, code: anchor });
  });

  it('a provisional Reject is tagged: nothing in the lane reads scoring_status', async () => {
    const h = harness({ src: source({ recommendation: 'reject', evidenceGrade: 'decision' }) });
    await h.run();
    expect(h.calls).toEqual(['add:tag-reject']);
  });

  it('a repeat makes no writes and reads no catalogue', async () => {
    const h = harness({ tags: [SELECT] });
    const r = await h.run();
    expect(h.calls).toEqual([]);
    expect(h.candidateTagList).not.toHaveBeenCalled();
    expect(r).toMatchObject({ committed: true, code: 'christy_tag_select' });
  });

  it('a verdict change adds the new tag BEFORE it removes the old one', async () => {
    const h = harness({ tags: [SELECT], src: source({ recommendation: 'reject' }) });
    await h.run();
    expect(h.calls).toEqual(['add:tag-reject', 'remove:tag-select']);
  });

  it('removes every other Christy tag on a candidate carrying several', async () => {
    const h = harness({ tags: [SELECT, BORDERLINE, REJECT], src: source({ recommendation: 'hold' }) });
    await h.run();
    expect(h.calls).toEqual(['remove:tag-select', 'remove:tag-reject']);
  });

  it.each([
    ['human_review stored as NULL', { recommendation: null }],
    ['insufficient evidence over a verdict', { recommendation: 'advance', evidenceGrade: 'insufficient' as const }],
  ])('%s removes what is there and adds nothing', async (_label, over) => {
    const h = harness({ tags: [SELECT], src: source(over) });
    const r = await h.run();
    expect(h.calls).toEqual(['remove:tag-select']);
    expect(h.candidateTagList).not.toHaveBeenCalled();
    expect(r).toMatchObject({ committed: true, code: 'christy_tag_none' });
  });

  it('no verdict and no tag: no writes, completes as none', async () => {
    const h = harness({ src: source({ recommendation: null }) });
    const r = await h.run();
    expect(h.calls).toEqual([]);
    expect(r).toMatchObject({ code: 'christy_tag_none' });
  });

  it('never touches another tag, including near-miss titles', async () => {
    const tags = [
      { id: 'tag-vip', title: 'VIP', isArchived: false },
      { id: 'near-1', title: 'christy: select', isArchived: false },
      { id: 'near-2', title: 'Christy: Selected', isArchived: false },
      { id: 'near-3', title: 'Christy:Reject', isArchived: false },
      SELECT,
    ];
    const h = harness({ tags, src: source({ recommendation: null }) });
    await h.run();
    expect(h.calls).toEqual(['remove:tag-select']);
  });

  it('a target tag that was since archived does not count: the active one goes on, the old one off', async () => {
    const h = harness({ tags: [{ id: 'old-select', title: 'Christy: Select', isArchived: true }] });
    await h.run();
    expect(h.calls).toEqual(['add:tag-select', 'remove:old-select']);
  });

  it('resumes after a partial run: a remove that failed is the only write left', async () => {
    const removes = vi.fn().mockRejectedValueOnce(new AshbyError('http_server_error', { httpStatus: 503 }));
    const first = harness({ tags: [SELECT], src: source({ recommendation: 'reject' }), client: { candidateRemoveTag: removes } });
    const r1 = await first.run();
    expect(first.client.candidateAddTag).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ code: 'ashby_tag_transient', committed: false });

    const second = harness({ tags: [SELECT, REJECT], src: source({ recommendation: 'reject' }) });
    const r2 = await second.run();
    expect(second.calls).toEqual(['remove:tag-select']);
    expect(r2).toMatchObject({ committed: true, code: 'christy_tag_reject' });
  });
});

describe('executeRecommendationTag: source and candidate', () => {
  it('an operation that is not the newest completes as superseded with no Ashby call', async () => {
    const h = harness({ src: source({ isNewestTagOperation: () => false }) });
    const r = await h.run();
    expect(r).toMatchObject({ committed: true, code: 'christy_tag_superseded' });
    expect(h.stores.completeOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'christy_tag_superseded', null);
    expect(h.client.candidateInfo).not.toHaveBeenCalled();
    expect(h.client.applicationInfo).not.toHaveBeenCalled();
  });

  it('passes the operation session to the store and asks about this operation', async () => {
    const isNewest = vi.fn(() => true);
    const h = harness({ src: source({ isNewestTagOperation: isNewest }) });
    await h.run();
    expect(h.stores.readRecommendationTagSource).toHaveBeenCalledWith('link-1', 'session-1');
    expect(isNewest).toHaveBeenCalledWith('op-1');
  });

  it('an unreadable source fails retryable assessment_missing', async () => {
    const h = harness({ src: null });
    expect(await h.run()).toMatchObject({ committed: false, code: 'assessment_missing' });
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'assessment_missing', true);
  });

  it('a throwing source read also fails retryable assessment_missing', async () => {
    const h = harness({ stores: { readRecommendationTagSource: vi.fn(async () => { throw new Error('db'); }) } });
    await h.run();
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'assessment_missing', true);
  });

  it('falls back to application.info and binds the id it found', async () => {
    const h = harness({ src: source({ externalCandidateId: null }) });
    await h.run();
    expect(h.client.applicationInfo).toHaveBeenCalledWith('app-1');
    expect(h.stores.bindLinkExternalCandidateId).toHaveBeenCalledWith('link-1', CAND);
    expect(h.client.candidateInfo).toHaveBeenCalledWith(CAND);
    expect(h.calls).toEqual(['add:tag-select']);
  });

  it('a failed bind does not stop the tag', async () => {
    const h = harness({
      src: source({ externalCandidateId: null }),
      stores: { bindLinkExternalCandidateId: vi.fn(async () => { throw new Error('db'); }) },
    });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(h.calls).toEqual(['add:tag-select']);
  });

  it('no candidate id anywhere fails non-retryable candidate_id_missing', async () => {
    const h = harness({
      src: source({ externalCandidateId: null }),
      client: { applicationInfo: vi.fn(async () => ({ results: { id: 'app-1' }, moreDataAvailable: false })) },
    });
    await h.run();
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'candidate_id_missing', false);
    expect(h.stores.bindLinkExternalCandidateId).not.toHaveBeenCalled();
  });

  it('no stored id and no application id fails the same way, with no Ashby call', async () => {
    const h = harness({ src: source({ externalCandidateId: null, externalApplicationId: null }) });
    await h.run();
    expect(h.client.applicationInfo).not.toHaveBeenCalled();
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'candidate_id_missing', false);
  });

  it('a candidate with no readable tags list writes nothing and fails attempt-bounded', async () => {
    const h = harness({
      client: { candidateInfo: vi.fn(async () => ({ results: { id: CAND }, moreDataAvailable: false })) },
    });
    expect(await h.run()).toMatchObject({ committed: false, code: 'operation_error' });
    expect(h.calls).toEqual([]);
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'operation_error', true);
  });
});

describe('executeRecommendationTag: config faults write nothing', () => {
  it('a missing tag re-reads the catalogue once, then defers an hour, keeping the old tag', async () => {
    const h = harness({
      tags: [SELECT],
      catalogue: [SELECT],
      src: source({ recommendation: 'reject' }),
    });
    expect(await h.run()).toMatchObject({ committed: false, code: 'ashby_tag_not_found' });
    expect(h.candidateTagList).toHaveBeenCalledTimes(2);
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_not_found', TAG_CONFIG_FAULT_DEFER_SECONDS);
    expect(h.calls).toEqual([]);
  });

  it('a tag the admin just created is found by the fresh read', async () => {
    const listTags = vi
      .fn()
      .mockResolvedValueOnce({ results: [], moreDataAvailable: false })
      .mockResolvedValueOnce({ results: [SELECT], moreDataAvailable: false });
    const h = harness({ listTags });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(h.calls).toEqual(['add:tag-select']);
  });

  it('an ambiguous title defers and writes nothing', async () => {
    const h = harness({
      tags: [REJECT],
      catalogue: [SELECT, { id: 'twin', title: 'Christy: Select', isArchived: false }],
    });
    expect(await h.run()).toMatchObject({ code: 'ashby_tag_ambiguous' });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_ambiguous', TAG_CONFIG_FAULT_DEFER_SECONDS);
    expect(h.calls).toEqual([]);
  });

  it('a truncated catalogue is a transient wait, never "not found"', async () => {
    const listTags = vi.fn(async () => ({ results: [], moreDataAvailable: true }));
    const h = harness({ listTags });
    expect(await h.run()).toMatchObject({ code: 'ashby_tag_transient' });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_transient', TAG_TRANSIENT_DEFER_SECONDS);
    expect(listTags).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['HTTP 403 on candidate.info', { client: { candidateInfo: vi.fn(async () => { throw http(403); }) } }],
    ['HTTP 401 on candidate.info', { client: { candidateInfo: vi.fn(async () => { throw http(401); }) } }],
    ['HTTP 403 on candidateTag.list', { listTags: vi.fn(async () => { throw http(403); }) }],
    ['HTTP 403 on addTag', { client: { candidateAddTag: vi.fn(async () => { throw http(403); }) } }],
    ['the code on candidate.info', { client: { candidateInfo: vi.fn(async () => { throw logical('missing_endpoint_permission'); }) } }],
    ['the code on addTag, no re-read', { client: { candidateAddTag: vi.fn(async () => { throw logical('missing_endpoint_permission'); }) } }],
  ])('%s is a permission fault: defer an hour', async (_label, over) => {
    const h = harness(over as never);
    expect(await h.run()).toMatchObject({ committed: false, code: 'ashby_tag_permission_denied' });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_permission_denied', TAG_CONFIG_FAULT_DEFER_SECONDS);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });

  it('a permission fault on the write does not spend a re-read', async () => {
    const candidateInfo = vi.fn(async () => ({ results: { id: CAND, tags: [] }, moreDataAvailable: false }));
    const h = harness({
      client: { candidateInfo, candidateAddTag: vi.fn(async () => { throw logical('missing_endpoint_permission'); }) },
    });
    await h.run();
    expect(candidateInfo).toHaveBeenCalledTimes(1);
  });
});

describe('executeRecommendationTag: transient faults', () => {
  it.each([
    ['429', new AshbyError('rate_limited', { httpStatus: 429 })],
    ['5xx', new AshbyError('http_server_error', { httpStatus: 503 })],
    ['timeout, not retriable as the client says', new AshbyError('timeout', { retriable: false })],
    ['network', new AshbyError('network', {})],
    ['retry_exhausted', new AshbyError('retry_exhausted', { retriable: false })],
  ])('%s defers five minutes and never fails terminally', async (_label, error) => {
    const h = harness({ client: { candidateInfo: vi.fn(async () => { throw error; }) } });
    expect(await h.run()).toMatchObject({ committed: false, code: 'ashby_tag_transient' });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_transient', TAG_TRANSIENT_DEFER_SECONDS);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });

  it('applies to the writes too', async () => {
    const h = harness({ client: { candidateAddTag: vi.fn(async () => { throw new AshbyError('timeout', {}); }) } });
    expect(await h.run()).toMatchObject({ code: 'ashby_tag_transient' });
  });

  it('applies to the application.info fallback', async () => {
    const h = harness({
      src: source({ externalCandidateId: null }),
      client: { applicationInfo: vi.fn(async () => { throw new AshbyError('network', {}); }) },
    });
    expect(await h.run()).toMatchObject({ code: 'ashby_tag_transient' });
  });
});

describe('executeRecommendationTag: the age limit ends a wait', () => {
  const old = new Date(NOW - TAG_DEFER_AGE_LIMIT_MS - 1).toISOString();

  it.each([
    ['transient', { client: { candidateInfo: vi.fn(async () => { throw new AshbyError('network', {}); }) } }, 'ashby_tag_transient'],
    ['permission', { client: { candidateInfo: vi.fn(async () => { throw http(403); }) } }, 'ashby_tag_permission_denied'],
    ['not found', { catalogue: [] }, 'ashby_tag_not_found'],
  ])('%s older than 7 days fails non-retryable with the same code', async (_label, over, code) => {
    const h = harness({ ...over, claim: { createdAt: old } } as never);
    expect(await h.run()).toMatchObject({ committed: false, code });
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', code, false);
    expect(h.stores.deferOperation).not.toHaveBeenCalled();
  });

  it('exactly at the limit still defers', async () => {
    const h = harness({
      catalogue: [],
      claim: { createdAt: new Date(NOW - TAG_DEFER_AGE_LIMIT_MS).toISOString() },
    });
    await h.run();
    expect(h.stores.deferOperation).toHaveBeenCalledTimes(1);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'not-a-date'])('an unknown age (%s) keeps deferring', async (createdAt) => {
    const h = harness({ catalogue: [], claim: { createdAt } });
    await h.run();
    expect(h.stores.deferOperation).toHaveBeenCalledTimes(1);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });
});

describe('executeRecommendationTag: a logical failure on a write looks before it fails', () => {
  it('add refused, tag is there after all: completes', async () => {
    const candidateInfo = vi
      .fn()
      .mockResolvedValueOnce({ results: { tags: [] }, moreDataAvailable: false })
      .mockResolvedValueOnce({ results: { tags: [SELECT] }, moreDataAvailable: false });
    const h = harness({ client: { candidateInfo, candidateAddTag: vi.fn(async () => { throw logical('already_tagged'); }) } });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(candidateInfo).toHaveBeenCalledTimes(2);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });

  it('remove refused, tag is gone after all: completes', async () => {
    const candidateInfo = vi
      .fn()
      .mockResolvedValueOnce({ results: { tags: [SELECT] }, moreDataAvailable: false })
      .mockResolvedValueOnce({ results: { tags: [] }, moreDataAvailable: false });
    const h = harness({
      src: source({ recommendation: null }),
      client: { candidateInfo, candidateRemoveTag: vi.fn(async () => { throw logical('tag_not_present'); }) },
    });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_none' });
  });

  it('refused and not there: fails non-retryable with the sanitized endpoint code', async () => {
    const h = harness({ client: { candidateAddTag: vi.fn(async () => { throw logical('Tag_Refused'); }) } });
    expect(await h.run()).toMatchObject({ committed: false, code: 'ashby_tag_write_rejected:tag_refused' });
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_write_rejected:tag_refused', false);
  });

  it('no code, or one that would not fit the column, gives the plain code', async () => {
    const none = harness({ client: { candidateAddTag: vi.fn(async () => { throw logical(); }) } });
    expect(await none.run()).toMatchObject({ code: 'ashby_tag_write_rejected' });
    const long = harness({ client: { candidateAddTag: vi.fn(async () => { throw logical('c'.repeat(60)); }) } });
    expect(await long.run()).toMatchObject({ code: 'ashby_tag_write_rejected' });
    for (const call of (long.stores.failOperation as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string, string, boolean]>) {
      expect(call[2]).toMatch(/^[a-z0-9_.:-]{1,64}$/);
    }
  });

  it('new tag on but the old one will not come off: not the desired state, so it fails', async () => {
    const candidateInfo = vi
      .fn()
      .mockResolvedValueOnce({ results: { tags: [SELECT] }, moreDataAvailable: false })
      .mockResolvedValueOnce({ results: { tags: [SELECT, REJECT] }, moreDataAvailable: false });
    const h = harness({
      src: source({ recommendation: 'reject' }),
      client: { candidateInfo, candidateRemoveTag: vi.fn(async () => { throw logical(); }) },
    });
    expect(await h.run()).toMatchObject({ committed: false, code: 'ashby_tag_write_rejected' });
  });

  it('a transient failure on the re-read defers instead', async () => {
    const candidateInfo = vi
      .fn()
      .mockResolvedValueOnce({ results: { tags: [] }, moreDataAvailable: false })
      .mockRejectedValueOnce(new AshbyError('network', {}));
    const h = harness({ client: { candidateInfo, candidateAddTag: vi.fn(async () => { throw logical(); }) } });
    expect(await h.run()).toMatchObject({ code: 'ashby_tag_transient' });
  });
});

describe('executeRecommendationTag: everything else', () => {
  it.each([
    ['a plain error', new TypeError('boom')],
    ['HTTP 404', http(404)],
    ['a malformed response', new AshbyError('malformed_response', {})],
    ['a client-side refusal', new AshbyError('invalid_request', { code: 'invalid_id' })],
    ['a logical failure on a read', logical('candidate_not_found')],
  ])('%s fails retryable operation_error, attempt-bounded', async (_label, error) => {
    const h = harness({ client: { candidateInfo: vi.fn(async () => { throw error; }) } });
    expect(await h.run()).toMatchObject({ committed: false, code: 'operation_error' });
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'operation_error', true);
    expect(h.stores.deferOperation).not.toHaveBeenCalled();
  });

  it('a lost lease on complete reports stale, not committed', async () => {
    const h = harness({ stores: { completeOperation: vi.fn(async () => 'not_owned' as const) } });
    expect(await h.run()).toMatchObject({ committed: false, staleLease: true });
  });

  it('a lost lease on defer and on fail reports stale', async () => {
    const d = harness({ catalogue: [], stores: { deferOperation: vi.fn(async () => 'not_owned' as const) } });
    expect(await d.run()).toMatchObject({ staleLease: true });
    const f = harness({ src: null, stores: { failOperation: vi.fn(async () => 'not_owned' as const) } });
    expect(await f.run()).toMatchObject({ staleLease: true });
  });

  it('never throws, even with the store down', async () => {
    const down = vi.fn(async () => { throw new Error('db down'); });
    const h = harness({
      client: { candidateInfo: vi.fn(async () => { throw new TypeError('boom'); }) },
      stores: { failOperation: down },
    });
    await expect(h.run()).resolves.toMatchObject({ claimed: true, committed: false, code: 'operation_error' });
  });

  it('events are metadata only: no id, no candidate, no title', async () => {
    const h = harness({ tags: [SELECT], src: source({ recommendation: 'reject' }) });
    await h.run();
    const text = JSON.stringify(h.events);
    expect(h.events.length).toBeGreaterThan(0);
    for (const secret of [CAND, 'tag-select', 'tag-reject', 'link-1', 'session-1', 'Christy:']) {
      expect(text).not.toContain(secret);
    }
  });
});

// ── The worker's lane ───────────────────────────────────────────────────────

const link: WorkflowLinkRow = {
  id: 'link-1', externalApplicationId: 'app-1', externalJobId: 'job-1', jobMappingId: 'map-1',
  externalResumeFileHandle: null, candidateId: 'c-1', sessionId: 'session-1', inviteId: null,
  lifecycle: 'writeback_pending', terminalState: null,
};

function workerStores(over: Partial<RuntimeWorkflowStores> = {}): RuntimeWorkflowStores {
  return {
    findLinkByApplicationId: async () => null,
    createLink: async () => ({ id: 'link-1' }),
    advanceIngestion: async () => ({ status: 'ok' }),
    enqueueOperation: async () => ({ status: 'inserted', id: 'op' }),
    completeOperation: async () => 'ok',
    failOperation: async () => ({ outcome: 'retry' }),
    deferOperation: async () => 'ok',
    claimOperation: async () => claim,
    parkOperationAwaitingDelivery: async () => 'ok',
    readIngestion: async () => ({ state: 'ready', attempts: 0 }),
    readLink: async () => link,
    markWritebackPending: async () => ({ status: 'ok' }),
    readRecommendationTagSource: async () => source(),
    ...over,
  };
}

const workerDeps = (over: Partial<Parameters<typeof runClaimedAshbyOperation>[0]> = {}) => ({
  stores: workerStores(),
  materialization: {} as never,
  resolveMappingForLink: async () => null,
  reissuePathFor: () => '/x',
  email: { providerApproved: false, domainVerified: false },
  owner: 'w1',
  leaseSeconds: 30,
  ...over,
});

function adapter(tags: unknown[] = []) {
  const client: RecommendationTagClient = {
    applicationInfo: vi.fn(async () => ({ results: {}, moreDataAvailable: false })),
    candidateInfo: vi.fn(async () => ({ results: { tags }, moreDataAvailable: false })),
    candidateAddTag: vi.fn(async () => undefined),
    candidateRemoveTag: vi.fn(async () => undefined),
  };
  const resolver = createChristyTagResolver({
    candidateTagList: async () => ({ results: CATALOGUE, moreDataAvailable: false }),
  });
  return { client, resolver };
}

describe('runClaimedAshbyOperation: the tag lane', () => {
  it('claims recommendation_tag only when the adapter is supplied, and executes it', async () => {
    const claimOperation = vi.fn(async () => claim);
    const a = adapter();
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({ claimOperation: claimOperation as never }),
      recommendationTag: a,
    }));
    expect(claimOperation.mock.calls[0]).toEqual(['recommendation_tag', 'w1', 30]);
    expect(a.client.candidateAddTag).toHaveBeenCalledWith(CAND, 'tag-select');
    expect(r).toMatchObject({ committed: true, code: 'christy_tag_select' });
  });

  it('a terminal link fails terminal_cancel with no Ashby call', async () => {
    const a = adapter();
    const failOperation = vi.fn(async () => ({ outcome: 'failed' as const }));
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({
        failOperation,
        readLink: async () => ({ ...link, terminalState: 'withdrawn' }),
      }),
      recommendationTag: a,
    }));
    expect(r).toMatchObject({ code: 'blocked_terminal' });
    expect(failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'terminal_cancel', false);
    expect(a.client.candidateInfo).not.toHaveBeenCalled();
  });

  it('a tag claim without its adapter fails closed: it never falls into the invite code', async () => {
    const materialization = new Proxy({}, { get() { throw new Error('invite code reached'); } });
    const failOperation = vi.fn(async () => ({ outcome: 'failed' as const }));
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({ failOperation }),
      materialization: materialization as never,
    }));
    expect(r).toMatchObject({ code: 'recommendation_tag_sink_unavailable' });
    expect(failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'recommendation_tag_sink_unavailable', false);
  });

  it('a timeout defers: it does not reach the worker catch, which would make it terminal', async () => {
    const a = adapter();
    (a.client.candidateInfo as ReturnType<typeof vi.fn>).mockRejectedValue(new AshbyError('timeout', { retriable: false }));
    const failOperation = vi.fn(async () => ({ outcome: 'failed' as const }));
    const deferOperation = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({ failOperation, deferOperation }),
      recommendationTag: a,
    }));
    expect(r).toMatchObject({ code: 'ashby_tag_transient' });
    expect(deferOperation).toHaveBeenCalledTimes(1);
    expect(failOperation).not.toHaveBeenCalled();
  });

  it('still refuses stage_move', () => {
    expect([...REFUSED_OPERATION_TYPES]).toEqual(['stage_move']);
  });
});

describe('runAshbyOperationPass: three explicit lanes', () => {
  const scorecard = {
    submit: async () => ({}),
    dashboardOrigin: 'https://dashboard.example.test',
  };

  it('polls invite, then scorecard, then tag', async () => {
    const types: string[] = [];
    const claimOperation = vi.fn(async (t: string) => { types.push(t); return null; });
    const r = await runAshbyOperationPass(workerDeps({
      stores: workerStores({ claimOperation: claimOperation as never }),
      scorecard,
      recommendationTag: adapter(),
    }));
    expect(types).toEqual(['invite_delivery', 'scorecard_write', 'recommendation_tag']);
    expect(r).toEqual({
      invite: { claimed: false },
      scorecard: { claimed: false },
      recommendationTag: { claimed: false },
    });
  });

  it('with no tag adapter the lane does not run at all', async () => {
    const types: string[] = [];
    const claimOperation = vi.fn(async (t: string) => { types.push(t); return null; });
    const r = await runAshbyOperationPass(workerDeps({
      stores: workerStores({ claimOperation: claimOperation as never }),
      scorecard,
    }));
    expect(types).toEqual(['invite_delivery', 'scorecard_write']);
    expect(r.recommendationTag).toEqual({ claimed: false });
  });

  it('the invite and scorecard passes never receive the tag adapter', async () => {
    const a = adapter();
    const inviteClaim: OperationClaimRow = { ...claim, id: 'op-invite', operationType: 'invite_delivery' };
    const claimOperation = vi.fn(async (t: string) => (t === 'invite_delivery' ? inviteClaim : null));
    const failOperation = vi.fn(async () => ({ outcome: 'failed' as const }));
    const r = await runAshbyOperationPass(workerDeps({
      stores: workerStores({ claimOperation: claimOperation as never, failOperation }),
      recommendationTag: a,
    }));
    // The invite claim runs invite code; the retired-lane guard answers it.
    expect(r.invite).toMatchObject({ claimed: true, operationType: 'invite_delivery' });
    expect(a.client.candidateInfo).not.toHaveBeenCalled();
    expect(a.client.candidateAddTag).not.toHaveBeenCalled();
  });
});
