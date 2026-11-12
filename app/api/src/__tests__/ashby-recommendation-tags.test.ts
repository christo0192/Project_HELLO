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
  TAG_CONTENDED,
  TAG_DEFER_AGE_LIMIT_MS,
  TAG_TRANSIENT_DEFER_SECONDS,
  TAG_VERDICT_UNREADABLE,
  TagRunOutOfTime,
  christyTagForVerdict,
  createChristyTagResolver,
  executeRecommendationTag,
  recommendationTagsEnabled,
  tagCallBudget,
  type RecommendationTagClient,
  type RecommendationTagDeps,
} from '../integrations/ashby/recommendation-tags.js';
import type { AshbyCallOptions } from '../integrations/ashby/types.js';
import {
  REFUSED_OPERATION_TYPES,
  runAshbyOperationPass,
  runClaimedAshbyOperation,
} from '../integrations/ashby/operation-worker.js';
import type {
  OperationClaimRow,
  RecommendationTagLink,
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

function clientWith(steps: Array<AshbyTransportResponse | Error>, sleep: (ms: number) => Promise<void> = async () => {}) {
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
    sleep,
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

  it.each([
    ['candidateAddTag', (c: AshbyClient, o: AshbyCallOptions) => c.candidateAddTag(CAND, 'tag-1', o)],
    ['candidateRemoveTag', (c: AshbyClient, o: AshbyCallOptions) => c.candidateRemoveTag(CAND, 'tag-1', o)],
    ['candidateInfo', (c: AshbyClient, o: AshbyCallOptions) => c.candidateInfo(CAND, undefined, o)],
    ['applicationInfo', (c: AshbyClient, o: AshbyCallOptions) => c.applicationInfo('app-1', undefined, o)],
    ['candidateTagList', (c: AshbyClient, o: AshbyCallOptions) => c.candidateTagList({ deadlineAt: o.deadlineAt })],
  ] as const)('%s honours a deadline: past it nothing is sent, and it never reaches the body', async (_name, call) => {
    const past = clientWith([okEnvelope()]);
    await expect(call(past.client, { deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ category: 'timeout' });
    expect(past.calls).toHaveLength(0);

    const future = clientWith([okEnvelope()]);
    await call(future.client, { deadlineAt: Date.now() + 60_000 });
    expect(future.calls).toHaveLength(1);
    expect(future.calls[0].body).not.toContain('deadline');
  });

  it('a deadline shortens a Retry-After wait on a tag write', async () => {
    const sleeps: number[] = [];
    const rateLimited: AshbyTransportResponse = {
      status: 429, ok: false, headers: { get: (h: string) => (h === 'retry-after' ? '30' : null) }, text: async () => '{}',
    };
    const { client } = clientWith([rateLimited, okEnvelope()], async (ms) => { sleeps.push(ms); });
    await client.candidateAddTag(CAND, 'tag-1', { deadlineAt: Date.now() + 2_000 });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(2_000);
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
    expect(christyTagForVerdict({ recommendation })).toBe(tag);
  });

  it.each([null, undefined, 'human_review', '', 'Advance', 'select', 1])('no verdict: %s -> null', (recommendation) => {
    expect(christyTagForVerdict({ recommendation })).toBeNull();
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
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select', cached: false });
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
    expect(await r.resolve('Christy: Reject')).toEqual({ status: 'found', tagId: 'tag-reject', cached: false });
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
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select', cached: false });
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
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select', cached: false });
  });

  it('trims, then matches exactly and case-sensitively', async () => {
    const trimmed = createChristyTagResolver({
      candidateTagList: pages({ results: [{ id: 'spaced', title: '  Christy: Reject ', isArchived: false }] }),
    });
    expect(await trimmed.resolve('Christy: Reject')).toEqual({ status: 'found', tagId: 'spaced', cached: false });

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

  it('caches a complete read for five minutes, then reads again, and says which answer was cached', async () => {
    let now = NOW;
    const candidateTagList = pages({ results: CATALOGUE });
    const r = createChristyTagResolver({ candidateTagList }, () => now);
    expect(await r.resolve('Christy: Select')).toMatchObject({ cached: false });
    expect(await r.resolve('Christy: Reject')).toMatchObject({ cached: true });
    now += CHRISTY_TAG_CACHE_MS - 1;
    expect(await r.resolve('Christy: Borderline')).toMatchObject({ cached: true });
    expect(candidateTagList).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await r.resolve('Christy: Select')).toMatchObject({ cached: false });
    expect(candidateTagList).toHaveBeenCalledTimes(2);
  });

  it('fresh bypasses the cache and refreshes it', async () => {
    const candidateTagList = pages({ results: [] }, { results: [SELECT] });
    const r = createChristyTagResolver({ candidateTagList });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'not_found' });
    expect(await r.resolve('Christy: Select', { fresh: true })).toEqual({ status: 'found', tagId: 'tag-select', cached: false });
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select', cached: true });
    expect(candidateTagList).toHaveBeenCalledTimes(2);
  });

  it('invalidate drops the cache: the next resolve reads Ashby again', async () => {
    const candidateTagList = pages({ results: [SELECT] });
    const r = createChristyTagResolver({ candidateTagList });
    await r.resolve('Christy: Select');
    r.invalidate?.();
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select', cached: false });
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
    expect(await r.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select', cached: false });
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

type FakeTag = { id: string; title: string; isArchived: boolean };

/** The candidate's verdict as the 0134 RPC answers it. */
function source(over: Partial<RecommendationTagSource> = {}): RecommendationTagSource {
  return { status: 'ok', recommendation: 'advance', evidenceGrade: 'decision', ...over };
}

const LINK: RecommendationTagLink = { externalCandidateId: CAND, externalApplicationId: 'app-1' };

/**
 * One candidate in Ashby, with real state: a write changes what the next
 * `candidate.info` reads, as it does in the tenant. A write answers the
 * Candidate, as documented. `known` names what an id is when it is added.
 */
class FakeCandidate {
  tags: FakeTag[];
  private readonly known = new Map<string, FakeTag>();

  constructor(initial: FakeTag[], known: FakeTag[]) {
    this.tags = [...initial];
    for (const t of [...known, ...initial]) this.known.set(t.id, t);
  }

  add(tagId: string): void {
    if (this.tags.some((t) => t.id === tagId)) return;
    this.tags.push(this.known.get(tagId) ?? { id: tagId, title: 'Unknown', isArchived: false });
  }

  remove(tagId: string): void {
    this.tags = this.tags.filter((t) => t.id !== tagId);
  }

  answer() {
    return { results: { id: CAND, tags: [...this.tags] }, moreDataAvailable: false };
  }

  christyIds(): string[] {
    return this.tags.filter((t) => t.title.startsWith('Christy: ')).map((t) => t.id).sort();
  }
}

function harness(opts: {
  tags?: FakeTag[];
  known?: FakeTag[];
  link?: RecommendationTagLink | null;
  src?: RecommendationTagSource | null;
  catalogue?: unknown[];
  claim?: Partial<OperationClaimRow>;
  client?: Partial<RecommendationTagClient>;
  stores?: Partial<RecommendationTagDeps['stores']>;
  listTags?: ReturnType<typeof vi.fn>;
  /** The run's clock, claim time and lease. Default: a frozen clock and no deadline. */
  run?: Pick<RecommendationTagDeps, 'nowMs' | 'claimedAtMs' | 'leaseSeconds'>;
} = {}) {
  const calls: string[] = [];
  const ashby = new FakeCandidate(opts.tags ?? [], [...CATALOGUE, ...(opts.known ?? [])] as FakeTag[]);
  const client: RecommendationTagClient = {
    applicationInfo: vi.fn(async () => ({ results: { id: 'app-1', candidate: { id: CAND } }, moreDataAvailable: false })),
    candidateInfo: vi.fn(async () => ashby.answer()),
    candidateAddTag: vi.fn(async (_c: string, tagId: string) => { calls.push(`add:${tagId}`); ashby.add(tagId); return ashby.answer(); }),
    candidateRemoveTag: vi.fn(async (_c: string, tagId: string) => { calls.push(`remove:${tagId}`); ashby.remove(tagId); return ashby.answer(); }),
    ...opts.client,
  };
  const candidateTagList = opts.listTags ?? vi.fn(async () => ({ results: opts.catalogue ?? CATALOGUE, moreDataAvailable: false }));
  const resolver = createChristyTagResolver({ candidateTagList: candidateTagList as never }, opts.run?.nowMs ?? (() => NOW));
  const stores = {
    completeOperation: vi.fn(async () => 'ok' as const),
    failOperation: vi.fn(async () => ({ outcome: 'retry' as const })),
    deferOperation: vi.fn(async () => 'ok' as const),
    readRecommendationTagLink: vi.fn(async () => (opts.link === undefined ? LINK : opts.link)),
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
        adapter: { client, resolver },
        nowMs: () => NOW,
        onEvent: (e) => events.push(e),
        ...opts.run,
      },
    );
  return { ashby, client, stores, calls, run, events, candidateTagList, resolver };
}

const http = (status: number) => new AshbyError('http_client_error', { httpStatus: status });
const logical = (...endpointCodes: string[]) => new AshbyError('logical_failure', { httpStatus: 200, endpointCodes });
const transientError = () => new AshbyError('http_server_error', { httpStatus: 503 });

describe('executeRecommendationTag: applying the verdict', () => {
  it.each([
    ['advance', 'tag-select', 'christy_tag_select'],
    ['hold', 'tag-borderline', 'christy_tag_borderline'],
    ['reject', 'tag-reject', 'christy_tag_reject'],
  ])('%s adds its tag and completes with the anchor and a NULL marker', async (recommendation, tagId, anchor) => {
    const h = harness({ src: source({ recommendation }) });
    const r = await h.run();
    expect(h.calls).toEqual([`add:${tagId}`]);
    expect(h.ashby.christyIds()).toEqual([tagId]);
    expect(h.stores.completeOperation).toHaveBeenCalledWith('op-1', 'lease-1', anchor, null);
    expect(r).toEqual({ claimed: true, operationType: 'recommendation_tag', committed: true, staleLease: false, code: anchor });
  });

  it('a provisional Reject is tagged: nothing in the lane reads scoring_status', async () => {
    const h = harness({ src: source({ recommendation: 'reject', evidenceGrade: 'decision' }) });
    await h.run();
    expect(h.calls).toEqual(['add:tag-reject']);
  });

  it('a repeat makes no writes, reads no catalogue and reads the candidate once', async () => {
    const h = harness({ tags: [SELECT] });
    const r = await h.run();
    expect(h.calls).toEqual([]);
    expect(h.candidateTagList).not.toHaveBeenCalled();
    expect(h.client.candidateInfo).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ committed: true, code: 'christy_tag_select' });
  });

  it('a verdict change adds the new tag BEFORE it removes the old one, then looks again', async () => {
    const h = harness({ tags: [SELECT], src: source({ recommendation: 'reject' }) });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_reject' });
    expect(h.calls).toEqual(['add:tag-reject', 'remove:tag-select']);
    expect(h.client.candidateInfo).toHaveBeenCalledTimes(2);
  });

  it('removes every other Christy tag on a candidate carrying several', async () => {
    const h = harness({ tags: [SELECT, BORDERLINE, REJECT], src: source({ recommendation: 'hold' }) });
    await h.run();
    expect(h.calls).toEqual(['remove:tag-select', 'remove:tag-reject']);
    expect(h.ashby.christyIds()).toEqual(['tag-borderline']);
  });

  it.each([
    ['human_review stored as NULL', source({ recommendation: null })],
    ['human_review stored as NULL, graded insufficient', source({ recommendation: null, evidenceGrade: 'insufficient' })],
    ['no result on any of the candidate\'s links', { status: 'no_assessment' as const, recommendation: null, evidenceGrade: null }],
  ])('%s removes what is there and adds nothing', async (_label, src) => {
    const h = harness({ tags: [SELECT], src });
    const r = await h.run();
    expect(h.calls).toEqual(['remove:tag-select']);
    expect(h.candidateTagList).not.toHaveBeenCalled();
    expect(r).toMatchObject({ committed: true, code: 'christy_tag_none' });
  });

  // M028 owner decision: thin evidence does not suppress the tag.
  it.each([
    ['advance', 'christy_tag_select', 'add:tag-select'],
    ['hold', 'christy_tag_borderline', 'add:tag-borderline'],
    ['reject', 'christy_tag_reject', 'add:tag-reject'],
  ] as const)('verdict %s graded insufficient is still tagged with that lean', async (recommendation, code, add) => {
    const h = harness({ src: source({ recommendation, evidenceGrade: 'insufficient' }) });
    expect(await h.run()).toMatchObject({ committed: true, code });
    expect(h.calls).toEqual([add]);
  });

  it('a lean graded insufficient replaces an older tag', async () => {
    const h = harness({ tags: [SELECT], src: source({ recommendation: 'reject', evidenceGrade: 'insufficient' }) });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_reject' });
    expect(h.calls).toEqual(['add:tag-reject', 'remove:tag-select']);
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
    expect(h.ashby.tags.map((t) => t.id)).toEqual(['tag-vip', 'near-1', 'near-2', 'near-3']);
  });

  it('a target tag that was since archived does not count: the active one goes on, the old one off', async () => {
    const h = harness({ tags: [{ id: 'old-select', title: 'Christy: Select', isArchived: true }] });
    await h.run();
    expect(h.calls).toEqual(['add:tag-select', 'remove:old-select']);
  });

  it('resumes after a partial run: a remove that failed is the only write left', async () => {
    const first = harness({ tags: [SELECT], src: source({ recommendation: 'reject' }) });
    (first.client.candidateRemoveTag as ReturnType<typeof vi.fn>).mockRejectedValueOnce(transientError());
    const r1 = await first.run();
    expect(first.client.candidateAddTag).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ code: 'ashby_tag_transient', committed: false });

    const second = harness({ tags: first.ashby.tags, src: source({ recommendation: 'reject' }) });
    const r2 = await second.run();
    expect(second.calls).toEqual(['remove:tag-select']);
    expect(r2).toMatchObject({ committed: true, code: 'christy_tag_reject' });
  });
});

describe('executeRecommendationTag: the link, the candidate and the verdict', () => {
  it('reads the link, then asks for the candidate-wide verdict with the Ashby candidate id', async () => {
    const h = harness();
    await h.run();
    expect(h.stores.readRecommendationTagLink).toHaveBeenCalledWith('link-1');
    // Never the operation's own session: the verdict is the candidate's newest.
    expect(h.stores.readRecommendationTagSource).toHaveBeenCalledWith('link-1', CAND);
  });

  it('a link with no stored id resolves it from application.info, binds it, THEN reads the verdict with it', async () => {
    const h = harness({ link: { externalCandidateId: null, externalApplicationId: 'app-1' } });
    await h.run();
    expect(h.client.applicationInfo).toHaveBeenCalledWith('app-1');
    expect(h.stores.bindLinkExternalCandidateId).toHaveBeenCalledWith('link-1', CAND);
    expect(h.stores.readRecommendationTagSource).toHaveBeenCalledWith('link-1', CAND);
    const bound = (h.stores.bindLinkExternalCandidateId as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const read = (h.stores.readRecommendationTagSource as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(bound).toBeLessThan(read);
    expect(h.calls).toEqual(['add:tag-select']);
  });

  it('a failed bind does not stop the tag', async () => {
    const h = harness({
      link: { externalCandidateId: null, externalApplicationId: 'app-1' },
      stores: { bindLinkExternalCandidateId: vi.fn(async () => { throw new Error('db'); }) },
    });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
  });

  it('no candidate id anywhere fails non-retryable candidate_id_missing, before any verdict read', async () => {
    const h = harness({
      link: { externalCandidateId: null, externalApplicationId: 'app-1' },
      client: { applicationInfo: vi.fn(async () => ({ results: { id: 'app-1' }, moreDataAvailable: false })) },
    });
    await h.run();
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'candidate_id_missing', false);
    expect(h.stores.bindLinkExternalCandidateId).not.toHaveBeenCalled();
    expect(h.stores.readRecommendationTagSource).not.toHaveBeenCalled();
  });

  it('no stored id and no application id fails the same way, with no Ashby call', async () => {
    const h = harness({ link: { externalCandidateId: null, externalApplicationId: null } });
    await h.run();
    expect(h.client.applicationInfo).not.toHaveBeenCalled();
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'candidate_id_missing', false);
  });

  it.each([
    ['the link read answers null', { readRecommendationTagLink: vi.fn(async () => null) }],
    ['the link read throws', { readRecommendationTagLink: vi.fn(async () => { throw new Error('db'); }) }],
    ['the verdict read answers null', { readRecommendationTagSource: vi.fn(async () => null) }],
    ['the verdict read throws', { readRecommendationTagSource: vi.fn(async () => { throw new Error('db'); }) }],
  ])('%s: waits five minutes, writes nothing, spends no attempt', async (_label, stores) => {
    const h = harness({ stores });
    expect(await h.run()).toMatchObject({ committed: false, code: TAG_VERDICT_UNREADABLE });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', TAG_VERDICT_UNREADABLE, TAG_TRANSIENT_DEFER_SECONDS);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
    expect(h.client.candidateInfo).not.toHaveBeenCalled();
  });

  it('a candidate.info with no tags key reads as no tags: Ashby marks it required, so it is left out when empty', async () => {
    const h = harness();
    (h.client.candidateInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ results: { id: CAND }, moreDataAvailable: false });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(h.calls).toEqual(['add:tag-select']);
  });

  it('no tags key and no verdict: nothing to do, no write', async () => {
    const h = harness({ src: source({ recommendation: null }) });
    (h.client.candidateInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ results: { id: CAND }, moreDataAvailable: false });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_none' });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['tags is not a list', { id: CAND, tags: 'none' }],
    ['tags is null', { id: CAND, tags: null }],
    ['the candidate is a list', [{ id: CAND }]],
    ['the candidate is missing', null],
  ])('%s: malformed, so it waits five minutes and writes nothing', async (_label, results) => {
    const h = harness({ client: { candidateInfo: vi.fn(async () => ({ results, moreDataAvailable: false })) } });
    expect(await h.run()).toMatchObject({ committed: false, code: 'operation_error' });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'operation_error', TAG_TRANSIENT_DEFER_SECONDS);
    expect(h.calls).toEqual([]);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
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
    const h = harness({ client: { candidateAddTag: vi.fn(async () => { throw logical('missing_endpoint_permission'); }) } });
    await h.run();
    expect(h.client.candidateInfo).toHaveBeenCalledTimes(1);
  });
});

describe('executeRecommendationTag: transient faults', () => {
  it.each([
    ['429', new AshbyError('rate_limited', { httpStatus: 429 })],
    ['5xx', transientError()],
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
      link: { externalCandidateId: null, externalApplicationId: 'app-1' },
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
    ['an unknown error', { client: { candidateInfo: vi.fn(async () => { throw new TypeError('boom'); }) } }, 'operation_error'],
    ['an unreadable verdict', { src: null }, TAG_VERDICT_UNREADABLE],
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

describe('executeRecommendationTag: a refused write looks before it fails (TAG-3)', () => {
  it('add refused, but the target is on after all, with the stale tag still there: removes it and completes', async () => {
    // A send-phase timeout that Ashby applied, then a refused retry; or a recruiter
    // adding the tag by hand between our read and our write.
    const h = harness({ tags: [BORDERLINE] });
    h.client.candidateAddTag = vi.fn(async (_c: string, tagId: string) => { h.ashby.add(tagId); throw logical('already_tagged'); });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(h.calls).toEqual(['remove:tag-borderline']);
    expect(h.ashby.christyIds()).toEqual(['tag-select']);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });

  it('a remove refused because the tag is already gone counts as done, and the next stale tag still comes off', async () => {
    const h = harness({ tags: [SELECT, BORDERLINE, REJECT], src: source({ recommendation: 'hold' }) });
    const remove = h.client.candidateRemoveTag;
    h.client.candidateRemoveTag = vi.fn(async (c: string, tagId: string) => {
      if (tagId === 'tag-select') { h.ashby.remove(tagId); throw logical('tag_not_present'); }
      return remove(c, tagId);
    });
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_borderline' });
    expect(h.ashby.christyIds()).toEqual(['tag-borderline']);
    expect(h.calls).toEqual(['remove:tag-reject']);
  });

  it('a remove refused while the tag is still there fails non-retryable with the sanitized endpoint code', async () => {
    const h = harness({ tags: [SELECT], src: source({ recommendation: 'reject' }), client: { candidateRemoveTag: vi.fn(async () => { throw logical('Tag_Refused'); }) } });
    expect(await h.run()).toMatchObject({ committed: false, code: 'ashby_tag_write_rejected:tag_refused' });
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_write_rejected:tag_refused', false);
    // The new tag is on: the candidate is never left without the tag it should have.
    expect(h.ashby.christyIds()).toEqual(['tag-reject', 'tag-select']);
  });

  it('add refused and not on: one more try with a freshly read id, then it fails, removing nothing', async () => {
    const h = harness({ tags: [REJECT], client: { candidateAddTag: vi.fn(async () => { throw logical('Tag_Refused'); }) } });
    expect(await h.run()).toMatchObject({ committed: false, code: 'ashby_tag_write_rejected:tag_refused' });
    expect(h.client.candidateAddTag).toHaveBeenCalledTimes(2);
    expect(h.candidateTagList).toHaveBeenCalledTimes(2);
    expect(h.client.candidateRemoveTag).not.toHaveBeenCalled();
    expect(h.ashby.christyIds()).toEqual(['tag-reject']);
  });

  it('add refused once, then the retry with the fresh catalogue goes on: completes', async () => {
    const h = harness({ tags: [REJECT] });
    const add = h.client.candidateAddTag;
    (h.client as { candidateAddTag: unknown }).candidateAddTag = vi.fn()
      .mockRejectedValueOnce(logical('try_again'))
      .mockImplementation(add);
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(h.ashby.christyIds()).toEqual(['tag-select']);
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

  it('a transient failure on the re-read defers instead', async () => {
    const h = harness({ client: { candidateAddTag: vi.fn(async () => { throw logical(); }) } });
    (h.client.candidateInfo as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: { tags: [] }, moreDataAvailable: false })
      .mockRejectedValueOnce(new AshbyError('network', {}));
    expect(await h.run()).toMatchObject({ code: 'ashby_tag_transient' });
  });
});

describe('executeRecommendationTag: a cached tag id the admin changed (TAG-5)', () => {
  /** A resolver whose cache holds the id the first catalogue read returned. */
  async function warm(h: ReturnType<typeof harness>) {
    await h.resolver.resolve('Christy: Select');
    expect(h.candidateTagList).toHaveBeenCalledTimes(1);
  }

  it('renamed: the add lands under the new title, so a fresh id goes on and the right tag is there', async () => {
    const renamed = { id: 'tag-select-old', title: 'Old Select', isArchived: false };
    const fresh = { id: 'tag-select-new', title: 'Christy: Select', isArchived: false };
    const listTags = vi.fn()
      .mockResolvedValueOnce({ results: [{ ...renamed, title: 'Christy: Select' }], moreDataAvailable: false })
      .mockResolvedValueOnce({ results: [fresh], moreDataAvailable: false });
    const h = harness({ tags: [REJECT], listTags, known: [renamed, fresh] });
    await warm(h);
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(h.calls).toEqual(['add:tag-select-old', 'add:tag-select-new', 'remove:tag-reject']);
    expect(h.ashby.christyIds()).toEqual(['tag-select-new']);
    // The documented residual: the renamed tag stays. It is not a Christy title.
    expect(h.ashby.tags.map((t) => t.id)).toContain('tag-select-old');
    expect(h.candidateTagList).toHaveBeenCalledTimes(2);
  });

  it('archived: the add is refused, the fresh read finds no active tag, so it waits an hour and the old tag stays', async () => {
    const listTags = vi.fn()
      .mockResolvedValueOnce({ results: [SELECT], moreDataAvailable: false })
      .mockResolvedValue({ results: [], moreDataAvailable: false });
    const h = harness({ tags: [REJECT], listTags, client: { candidateAddTag: vi.fn(async () => { throw logical('tag_archived'); }) } });
    await warm(h);
    expect(await h.run()).toMatchObject({ committed: false, code: 'ashby_tag_not_found' });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_not_found', TAG_CONFIG_FAULT_DEFER_SECONDS);
    expect(h.client.candidateRemoveTag).not.toHaveBeenCalled();
    expect(h.ashby.christyIds()).toEqual(['tag-reject']);
  });

  it('a refused write drops the cache, so the next run reads the catalogue again', async () => {
    const h = harness({ tags: [SELECT], src: source({ recommendation: 'reject' }), client: { candidateRemoveTag: vi.fn(async () => { throw logical(); }) } });
    await h.run();
    const reads = h.candidateTagList.mock.calls.length;
    await h.resolver.resolve('Christy: Reject');
    expect(h.candidateTagList).toHaveBeenCalledTimes(reads + 1);
  });

  it('a cached id that is right is checked through the add answer: no extra read', async () => {
    const h = harness();
    await warm(h);
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    // The first read, then the settle read; the add's own answer did the check.
    expect(h.client.candidateInfo).toHaveBeenCalledTimes(2);
  });

  it('a cached id whose add answer carries no tags is checked by one read', async () => {
    const h = harness();
    const add = h.client.candidateAddTag;
    h.client.candidateAddTag = vi.fn(async (c: string, t: string) => { await add(c, t); return { results: {} }; });
    await warm(h);
    expect(await h.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(h.client.candidateInfo).toHaveBeenCalledTimes(3);
  });
});

describe('executeRecommendationTag: it looks again after writing (convergence)', () => {
  it('a Christy tag another writer added meanwhile is removed, and the operation waits to re-check', async () => {
    const h = harness();
    const add = h.client.candidateAddTag;
    h.client.candidateAddTag = vi.fn(async (c: string, t: string) => {
      const answer = await add(c, t);
      h.ashby.add('tag-reject'); // a second worker, a different verdict, at the same moment
      return answer;
    });
    expect(await h.run()).toMatchObject({ committed: false, code: TAG_CONTENDED });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', TAG_CONTENDED, TAG_TRANSIENT_DEFER_SECONDS);
    expect(h.calls).toEqual(['add:tag-select', 'remove:tag-reject']);
    expect(h.ashby.christyIds()).toEqual(['tag-select']);

    // The re-check: one tag, the right one, no write.
    const again = harness({ tags: h.ashby.tags });
    expect(await again.run()).toMatchObject({ committed: true, code: 'christy_tag_select' });
    expect(again.calls).toEqual([]);
  });

  it('its own tag gone by the re-check: it writes nothing more and waits; the next run decides afresh', async () => {
    const h = harness();
    const add = h.client.candidateAddTag;
    h.client.candidateAddTag = vi.fn(async (c: string, t: string) => {
      const answer = await add(c, t);
      h.ashby.remove('tag-select'); // another worker with a newer verdict took it off
      return answer;
    });
    expect(await h.run()).toMatchObject({ committed: false, code: TAG_CONTENDED });
    expect(h.calls).toEqual(['add:tag-select']);
    expect(h.client.candidateRemoveTag).not.toHaveBeenCalled();
  });

  it('a refusal in the leftover pass only waits', async () => {
    const h = harness();
    const add = h.client.candidateAddTag;
    h.client.candidateAddTag = vi.fn(async (c: string, t: string) => {
      const answer = await add(c, t);
      h.ashby.add('tag-reject');
      return answer;
    });
    h.client.candidateRemoveTag = vi.fn(async () => { throw logical('nope'); });
    expect(await h.run()).toMatchObject({ committed: false, code: TAG_CONTENDED });
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });
});

describe('executeRecommendationTag: everything else waits', () => {
  it.each([
    ['a plain error', new TypeError('boom')],
    ['HTTP 404', http(404)],
    ['a malformed response', new AshbyError('malformed_response', {})],
    ['a client-side refusal', new AshbyError('invalid_request', { code: 'invalid_id' })],
    ['a logical failure on a read', logical('candidate_not_found')],
  ])('%s defers five minutes as operation_error: no hot retry burns the attempts', async (_label, error) => {
    const h = harness({ client: { candidateInfo: vi.fn(async () => { throw error; }) } });
    expect(await h.run()).toMatchObject({ committed: false, code: 'operation_error' });
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'operation_error', TAG_TRANSIENT_DEFER_SECONDS);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });

  it('a lost lease on complete reports stale, not committed', async () => {
    const h = harness({ stores: { completeOperation: vi.fn(async () => 'not_owned' as const) } });
    expect(await h.run()).toMatchObject({ committed: false, staleLease: true });
  });

  it('a defer refused AND the fallback fail refused reports stale; a refused fail reports stale', async () => {
    const d = harness({
      catalogue: [],
      stores: {
        deferOperation: vi.fn(async () => 'not_owned' as const),
        failOperation: vi.fn(async () => 'not_owned' as const),
      },
    });
    expect(await d.run()).toMatchObject({ staleLease: true });
    const f = harness({
      link: { externalCandidateId: null, externalApplicationId: null },
      stores: { failOperation: vi.fn(async () => 'not_owned' as const) },
    });
    expect(await f.run()).toMatchObject({ staleLease: true });
  });

  it('never throws, even with the store down', async () => {
    const down = vi.fn(async () => { throw new Error('db down'); });
    const h = harness({
      client: { candidateInfo: vi.fn(async () => { throw new TypeError('boom'); }) },
      stores: { failOperation: down, deferOperation: down },
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

// ── The run's deadline under its lease (R2-TS-1, R2-DEPLOY-1) ───────────────

describe('tagCallBudget', () => {
  it.each([
    ['no claim time', undefined, 60],
    ['no lease', NOW, undefined],
    ['a zero lease', NOW, 0],
    ['a negative lease', NOW, -5],
    ['a claim time that is not a number', Number.NaN, 60],
  ])('%s: no deadline', (_label, claimedAtMs, leaseSeconds) => {
    expect(tagCallBudget(() => NOW, claimedAtMs, leaseSeconds)).toBeUndefined();
  });

  it('a 60 s lease runs 45 s, and no call starts with under 5 s left', () => {
    let now = NOW;
    const budget = tagCallBudget(() => now, NOW, 60)!;
    now = NOW + 40_000; // 5 s left: a call may start, cut off at the deadline
    const before = Date.now();
    const { deadlineAt } = budget.beforeCall();
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 5_000);
    now += 1;
    expect(() => budget.beforeCall()).toThrow(TagRunOutOfTime);
  });

  it('a lease under 30 s keeps half of itself, so the deadline is never at or before the start', () => {
    let now = NOW;
    const budget = tagCallBudget(() => now, NOW, 10)!; // a 5 s run; a call needs a third of it
    expect(() => budget.beforeCall()).not.toThrow();
    now = NOW + 3_333;
    expect(() => budget.beforeCall()).not.toThrow();
    now = NOW + 3_334;
    expect(() => budget.beforeCall()).toThrow(TagRunOutOfTime);
  });

  it('counts a lease over 900 s as 900 s, as the claim RPC clamps it', () => {
    let now = NOW + 880_000;
    const budget = tagCallBudget(() => now, NOW, 5_000)!;
    expect(() => budget.beforeCall()).not.toThrow();
    now += 1;
    expect(() => budget.beforeCall()).toThrow(TagRunOutOfTime);
  });

  it('the resolver spends it one catalogue page at a time, and running out mid-walk caches nothing', async () => {
    let now = NOW;
    type Page = { results: unknown[]; moreDataAvailable: boolean; nextCursor?: string };
    const candidateTagList = vi.fn(async (_params?: { cursor?: string; limit?: number; deadlineAt?: number }): Promise<Page> => {
      now += 20_000;
      return { results: [], moreDataAvailable: true, nextCursor: `c${candidateTagList.mock.calls.length}` };
    });
    const resolver = createChristyTagResolver({ candidateTagList }, () => now);
    const budget = tagCallBudget(() => now, NOW, 60)!;
    await expect(resolver.resolve('Christy: Select', { budget })).rejects.toBeInstanceOf(TagRunOutOfTime);
    // Pages start with 45, 25 and 5 s left; the fourth would start with none.
    expect(candidateTagList).toHaveBeenCalledTimes(3);
    for (const [params] of candidateTagList.mock.calls) expect(params?.deadlineAt).toEqual(expect.any(Number));
    candidateTagList.mockImplementation(async () => ({ results: [SELECT], moreDataAvailable: false }));
    expect(await resolver.resolve('Christy: Select')).toEqual({ status: 'found', tagId: 'tag-select', cached: false });
  });
});

/**
 * The outbox as 0031 and 0035 really behave: defer refuses a lease that has run
 * out (`lease_expires_at > p_now`), while fail and complete check only the token
 * and the state. Nothing reclaims a `running` row.
 */
function leasedOutbox(clock: { now: number }, leaseSeconds: number) {
  const expiresAt = clock.now + leaseSeconds * 1000;
  const row: { state: 'running' | 'pending' | 'failed' | 'succeeded'; deferredAt: number | null } = {
    state: 'running',
    deferredAt: null,
  };
  const stores = {
    deferOperation: vi.fn(async () => {
      if (row.state !== 'running' || clock.now >= expiresAt) return 'not_owned' as const;
      row.state = 'pending';
      row.deferredAt = clock.now;
      return 'ok' as const;
    }),
    failOperation: vi.fn(async (_id: string, _lease: string, _code: string, retryable: boolean) => {
      if (row.state !== 'running') return 'not_owned' as const;
      row.state = retryable ? 'pending' : 'failed';
      return { outcome: retryable ? ('retry' as const) : ('failed' as const) };
    }),
    completeOperation: vi.fn(async () => {
      if (row.state !== 'running') return 'not_owned' as const;
      row.state = 'succeeded';
      return 'ok' as const;
    }),
  };
  return { row, stores, expiresAt };
}

/**
 * An Ashby that takes `costMs` of the run's clock per call and honours the
 * deadline it is handed as the real client does: it gives up AT it, as a timeout.
 */
function slowAshby(h: ReturnType<typeof harness>, clock: { now: number }, costMs: number, failAdd?: AshbyError) {
  const spend = async (options?: AshbyCallOptions): Promise<void> => {
    const allowed = options?.deadlineAt !== undefined ? options.deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
    if (allowed < costMs) {
      clock.now += Math.max(0, allowed);
      throw new AshbyError('timeout', { code: 'deadline_exceeded' });
    }
    clock.now += costMs;
  };
  h.client.candidateInfo = vi.fn(async (_c: string, _e?: undefined, o?: AshbyCallOptions) => {
    await spend(o);
    return h.ashby.answer();
  });
  h.client.candidateAddTag = vi.fn(async (_c: string, tagId: string, o?: AshbyCallOptions) => {
    await spend(o);
    if (failAdd) throw failAdd;
    h.ashby.add(tagId);
    return h.ashby.answer();
  });
  h.candidateTagList.mockImplementation(async (params?: { deadlineAt?: number }) => {
    await spend(params);
    return { results: CATALOGUE, moreDataAvailable: false };
  });
}

describe('executeRecommendationTag: the run ends under its lease (R2-TS-1)', () => {
  it('a slow Ashby: the run stops before its deadline, and its defer lands while the lease is live', async () => {
    const clock = { now: NOW };
    const outbox = leasedOutbox(clock, 60);
    const h = harness({ stores: outbox.stores, run: { nowMs: () => clock.now, claimedAtMs: NOW, leaseSeconds: 60 } });
    slowAshby(h, clock, 14_000);
    // candidate.info ends at 14 s, the catalogue at 28 s, the add at 42 s. The
    // settle read would start with 3 s left of the 45 s run: it waits instead.
    expect(await h.run()).toEqual({
      claimed: true, operationType: 'recommendation_tag', committed: false, staleLease: false, code: 'ashby_tag_transient',
    });
    expect(outbox.row).toEqual({ state: 'pending', deferredAt: NOW + 42_000 });
    expect(outbox.row.deferredAt!).toBeLessThan(outbox.expiresAt);
    expect(outbox.stores.failOperation).not.toHaveBeenCalled();
    expect(h.client.candidateInfo).toHaveBeenCalledTimes(1);
    // The add is on; the next run only confirms it.
    expect(h.ashby.christyIds()).toEqual(['tag-select']);
    // Every call was handed the deadline.
    expect((h.client.candidateInfo as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ deadlineAt: expect.any(Number) });
    expect((h.client.candidateAddTag as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ deadlineAt: expect.any(Number) });
    expect(h.candidateTagList.mock.calls[0][0]).toMatchObject({ deadlineAt: expect.any(Number) });
  });

  it('a call cut off at the deadline is a timeout: the run waits, the lease still live', async () => {
    const clock = { now: NOW };
    const outbox = leasedOutbox(clock, 60);
    const h = harness({ stores: outbox.stores, run: { nowMs: () => clock.now, claimedAtMs: NOW, leaseSeconds: 60 } });
    slowAshby(h, clock, 25_000, transientError());
    // candidate.info ends at 25 s; the catalogue read starts with 20 s left and
    // is cut off at the 45 s deadline (less the few real milliseconds the test
    // itself takes, which the hand-over to the wall clock carries too).
    expect(await h.run()).toMatchObject({ committed: false, staleLease: false, code: 'ashby_tag_transient' });
    expect(outbox.row.state).toBe('pending');
    expect(outbox.row.deferredAt!).toBeGreaterThan(NOW + 44_000);
    expect(outbox.row.deferredAt!).toBeLessThanOrEqual(NOW + 45_000);
    expect(h.client.candidateAddTag).not.toHaveBeenCalled();
    expect(outbox.stores.failOperation).not.toHaveBeenCalled();
  });

  it('CONTROL: with no deadline the same Ashby overruns the lease; the refused defer falls back to a retryable fail', async () => {
    const clock = { now: NOW };
    const outbox = leasedOutbox(clock, 60);
    const h = harness({ stores: outbox.stores, run: { nowMs: () => clock.now } });
    slowAshby(h, clock, 25_000, transientError());
    // info 25 s, catalogue 50 s, the add fails at 75 s: past the 60 s lease.
    const r = await h.run();
    expect(outbox.stores.deferOperation).toHaveBeenCalledTimes(1);
    await expect(outbox.stores.deferOperation.mock.results[0].value).resolves.toBe('not_owned');
    expect(outbox.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_transient', true);
    // Back to pending, not stranded in `running`, and not reported stale.
    expect(outbox.row.state).toBe('pending');
    expect(r).toMatchObject({ committed: false, staleLease: false, code: 'ashby_tag_transient' });
    expect(h.events.map((e) => e.kind)).toEqual(['defer_refused', 'retry']);
  });

  it('a defer refused for any reason falls back to a retryable fail with the same code', async () => {
    const h = harness({
      catalogue: [],
      stores: { deferOperation: vi.fn(async () => 'not_owned' as const) },
    });
    expect(await h.run()).toMatchObject({ committed: false, staleLease: false, code: 'ashby_tag_not_found' });
    expect(h.stores.failOperation).toHaveBeenCalledTimes(1);
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_not_found', true);
  });

  it('a defer that succeeds never touches fail', async () => {
    const h = harness({ catalogue: [] });
    await h.run();
    expect(h.stores.deferOperation).toHaveBeenCalledTimes(1);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
    expect(h.events.map((e) => e.kind)).toEqual(['deferred']);
  });
});

describe('executeRecommendationTag: the age limit counts from the newest manual Retry (R2-TS-3)', () => {
  const old = new Date(NOW - TAG_DEFER_AGE_LIMIT_MS - 1).toISOString();
  const recent = new Date(NOW - 60_000).toISOString();

  it('an old operation Retried since waits again: its age counts from the Retry', async () => {
    const h = harness({ catalogue: [], claim: { createdAt: old, ageAnchor: recent } });
    await h.run();
    expect(h.stores.deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_not_found', TAG_CONFIG_FAULT_DEFER_SECONDS);
    expect(h.stores.failOperation).not.toHaveBeenCalled();
  });

  it('a Retry longer ago than the limit ends the wait like an old creation', async () => {
    const h = harness({ catalogue: [], claim: { createdAt: old, ageAnchor: old } });
    await h.run();
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_not_found', false);
    expect(h.stores.deferOperation).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'not-a-date'])('an unreadable anchor (%s) falls back to the creation time', async (ageAnchor) => {
    const h = harness({ catalogue: [], claim: { createdAt: old, ageAnchor } });
    await h.run();
    expect(h.stores.failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_not_found', false);
  });
});

describe('executeRecommendationTag: any failed write drops the tag-id cache (R2-TS-5)', () => {
  it.each([
    ['HTTP 404 on the add', { client: { candidateAddTag: vi.fn(async () => { throw http(404); }) } }],
    ['HTTP 422 on the remove', { tags: [SELECT], src: source({ recommendation: null }), client: { candidateRemoveTag: vi.fn(async () => { throw http(422); }) } }],
    ['a 5xx on the add', { client: { candidateAddTag: vi.fn(async () => { throw transientError(); }) } }],
    ['a logical failure on the remove', { tags: [SELECT], src: source({ recommendation: null }), client: { candidateRemoveTag: vi.fn(async () => { throw logical('nope'); }) } }],
  ])('%s: the next resolve reads the catalogue again', async (_label, over) => {
    const h = harness(over as never);
    await h.resolver.resolve('Christy: Select'); // the cache is warm
    const reads = h.candidateTagList.mock.calls.length;
    await h.run();
    await h.resolver.resolve('Christy: Reject');
    expect(h.candidateTagList).toHaveBeenCalledTimes(reads + 1);
  });

  it('CONTROL: a failed read keeps the cache', async () => {
    const h = harness({ client: { candidateInfo: vi.fn(async () => { throw http(404); }) } });
    await h.resolver.resolve('Christy: Select');
    const reads = h.candidateTagList.mock.calls.length;
    await h.run();
    await h.resolver.resolve('Christy: Reject');
    expect(h.candidateTagList).toHaveBeenCalledTimes(reads);
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
    readRecommendationTagLink: async () => LINK,
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
  // The frozen clock the claim fixture is dated against. Without it the worker
  // reads the wall clock, and once the real date passed NOW + 7 days the
  // fixture claim looked older than TAG_DEFER_AGE_LIMIT_MS, so defers turned
  // into fails.
  nowMs: () => NOW,
  ...over,
});

function adapter(tags: FakeTag[] = []) {
  const ashby = new FakeCandidate(tags, CATALOGUE as FakeTag[]);
  const client: RecommendationTagClient = {
    applicationInfo: vi.fn(async () => ({ results: {}, moreDataAvailable: false })),
    candidateInfo: vi.fn(async () => ashby.answer()),
    candidateAddTag: vi.fn(async (_c: string, tagId: string) => { ashby.add(tagId); return ashby.answer(); }),
    candidateRemoveTag: vi.fn(async (_c: string, tagId: string) => { ashby.remove(tagId); return ashby.answer(); }),
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
    // The worker hands the run its deadline, and every call carries it.
    expect(a.client.candidateAddTag).toHaveBeenCalledWith(CAND, 'tag-select', { deadlineAt: expect.any(Number) });
    expect(a.client.candidateInfo).toHaveBeenCalledWith(CAND, undefined, { deadlineAt: expect.any(Number) });
    expect(r).toMatchObject({ committed: true, code: 'christy_tag_select' });
  });

  it('the deadline counts from BEFORE the claim, on the worker clock, with the worker lease', async () => {
    // A 30 s lease leaves a 15 s run. The claim RPC takes 4 s and candidate.info
    // 7 s: 11 s in, 4 s are left, under the 5 s a call needs. Counted from the
    // claim's answer instead, 8 s would be left and the run would go on to write.
    let now = NOW;
    const claimOperation = vi.fn(async () => { now += 4_000; return claim; });
    const a = adapter();
    (a.client.candidateInfo as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now += 7_000;
      return { results: { id: CAND, tags: [] }, moreDataAvailable: false };
    });
    const deferOperation = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({ claimOperation: claimOperation as never, deferOperation }),
      recommendationTag: a,
      nowMs: () => now,
    }));
    expect(r).toMatchObject({ code: 'ashby_tag_transient', staleLease: false });
    expect(deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'ashby_tag_transient', TAG_TRANSIENT_DEFER_SECONDS);
    expect(a.client.candidateAddTag).not.toHaveBeenCalled();
  });

  it('a database error before the executor defers the tag: no hot retryable fail (R2-TS-2)', async () => {
    const a = adapter();
    const failOperation = vi.fn(async () => ({ outcome: 'retry' as const }));
    const deferOperation = vi.fn(async () => 'ok' as const);
    const events: Array<{ kind: string; code?: string }> = [];
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({
        failOperation,
        deferOperation,
        readLink: async () => { throw new Error('ashby_link_read_error'); },
      }),
      recommendationTag: a,
      onEvent: (e) => events.push(e),
    }));
    expect(r).toEqual({
      claimed: true, operationType: 'recommendation_tag', committed: false, staleLease: false, code: TAG_VERDICT_UNREADABLE,
    });
    expect(deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', TAG_VERDICT_UNREADABLE, TAG_TRANSIENT_DEFER_SECONDS);
    expect(failOperation).not.toHaveBeenCalled();
    expect(a.client.candidateInfo).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'deferred', code: TAG_VERDICT_UNREADABLE }));
  });

  it('a failed terminal write before the executor defers the tag too', async () => {
    const deferOperation = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({
        deferOperation,
        readLink: async () => ({ ...link, terminalState: 'withdrawn' }),
        failOperation: async () => { throw new Error('ashby_operation_fail_error'); },
      }),
      recommendationTag: adapter(),
    }));
    expect(r).toMatchObject({ code: TAG_VERDICT_UNREADABLE });
    expect(deferOperation).toHaveBeenCalledWith('op-1', 'lease-1', TAG_VERDICT_UNREADABLE, TAG_TRANSIENT_DEFER_SECONDS);
  });

  it('the preamble defer has the same fallback: a refused defer becomes a retryable fail', async () => {
    const failOperation = vi.fn(async () => ({ outcome: 'retry' as const }));
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({
        failOperation,
        deferOperation: async () => 'not_owned',
        readLink: async () => { throw new Error('ashby_link_read_error'); },
      }),
      recommendationTag: adapter(),
    }));
    expect(r).toMatchObject({ code: TAG_VERDICT_UNREADABLE, staleLease: false });
    expect(failOperation).toHaveBeenCalledWith('op-1', 'lease-1', TAG_VERDICT_UNREADABLE, true);
  });

  it('the preamble defer keeps the age limit', async () => {
    const failOperation = vi.fn(async () => ({ outcome: 'failed' as const }));
    const deferOperation = vi.fn(async () => 'ok' as const);
    await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({
        claimOperation: async () => ({ ...claim, createdAt: new Date(NOW - TAG_DEFER_AGE_LIMIT_MS - 1).toISOString() }),
        failOperation,
        deferOperation,
        readLink: async () => { throw new Error('ashby_link_read_error'); },
      }),
      recommendationTag: adapter(),
      nowMs: () => NOW,
    }));
    expect(failOperation).toHaveBeenCalledWith('op-1', 'lease-1', TAG_VERDICT_UNREADABLE, false);
    expect(deferOperation).not.toHaveBeenCalled();
  });

  it.each([
    ['invite_delivery', undefined],
    ['scorecard_write', { submit: async () => ({}), dashboardOrigin: 'https://dashboard.example.test' }],
  ] as const)('CONTROL: %s keeps its hot retryable fail on the same database error', async (operationType, scorecard) => {
    const failOperation = vi.fn(async () => ({ outcome: 'retry' as const }));
    const deferOperation = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(workerDeps({
      stores: workerStores({
        claimOperation: async () => ({ ...claim, operationType }),
        failOperation,
        deferOperation,
        readLink: async () => { throw new Error('ashby_link_read_error'); },
      }),
      ...(scorecard ? { scorecard } : {}),
    }));
    expect(r).toMatchObject({ code: 'operation_error' });
    expect(failOperation).toHaveBeenCalledWith('op-1', 'lease-1', 'operation_error', true);
    expect(deferOperation).not.toHaveBeenCalled();
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
