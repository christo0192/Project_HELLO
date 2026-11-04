/**
 * ashby-recommendation-tag-contract.test.ts — does the tag lane work against the
 * response shapes Ashby DOCUMENTS?
 *
 *   documented JSON envelope ─► REAL AshbyClient (injected transport, no network)
 *   ─► REAL worker lane ─► recorded store
 *
 * Documented shapes (developers.ashbyhq.com, reference pages `candidateinfo`,
 * `candidateaddtag`, `candidateremovetag`, `candidatetaglist`, and the
 * `authentication` and `responses` docs, read through a summariser 2026-11-03;
 * no live tenant call was made):
 *
 *   - `candidate.info` results: a Candidate whose required keys include `tags`,
 *     an array of CandidateTag `{ id, title, isArchived }`.
 *   - `candidate.addTag` / `candidate.removeTag`: POST `{ candidateId, tagId }`,
 *     additionalProperties false; answer `{ success: true, results: Candidate }`.
 *   - `candidateTag.list`: POST with optional `includeArchived`, `cursor`, `limit`
 *     (max 100), `syncToken`; answer `results` `[{ id, title, isArchived }]`,
 *     `moreDataAvailable`, `nextCursor`, and `syncToken` on the last page only.
 *     A page may be empty while `moreDataAvailable` is true.
 *   - A missing permission: HTTP 403 `missing_endpoint_permission`. The docs also
 *     show HTTP 200 `{ success: false, errorInfo: { code } }`, so both are pinned.
 *   - Other refusals: HTTP 200 `{ success: false, errors: [{ message, parameter? }] }`.
 *
 * Every id and name below is synthetic.
 */
import { describe, expect, it } from 'vitest';
import { createAshbyClient, type AshbyLogRecord, type AshbyTransportRequest, type AshbyTransportResponse } from '../integrations/ashby/client.js';
import { runClaimedAshbyOperation } from '../integrations/ashby/operation-worker.js';
import { createChristyTagResolver } from '../integrations/ashby/recommendation-tags.js';
import type {
  OperationClaimRow,
  RecommendationTagLink,
  RecommendationTagSource,
  RuntimeWorkflowStores,
  WorkflowLinkRow,
} from '../integrations/ashby/orchestration.js';

const CAND_ID = '7f2f1c3e-2222-4a00-8000-00000000c001';
const APP_ID = '7f2f1c3e-1111-4a00-8000-00000000a001';
const TAG_SELECT = '7f2f1c3e-5555-4a00-8000-000000000001';
const TAG_BORDERLINE = '7f2f1c3e-5555-4a00-8000-000000000002';
const TAG_REJECT = '7f2f1c3e-5555-4a00-8000-000000000003';
const TAG_OTHER = '7f2f1c3e-5555-4a00-8000-000000000009';

const tag = (id: string, title: string, isArchived = false) => ({ id, title, isArchived });
const SELECT = tag(TAG_SELECT, 'Christy: Select');
const BORDERLINE = tag(TAG_BORDERLINE, 'Christy: Borderline');
const REJECT = tag(TAG_REJECT, 'Christy: Reject');
const OTHER = tag(TAG_OTHER, 'Referral');

/** A documented Candidate: every required key, synthetic values. */
function candidate(tags: unknown[]) {
  return {
    id: CAND_ID,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    name: 'Synthetic Person',
    primaryEmailAddress: { value: 'synthetic@example.invalid', type: 'Work', isPrimary: true },
    emailAddresses: [],
    primaryPhoneNumber: null,
    phoneNumbers: [],
    socialLinks: [],
    tags,
    applicationIds: [APP_ID],
    fileHandles: [],
    profileUrl: 'https://app.ashbyhq.com/candidates/synthetic',
  };
}

/**
 * The candidate's tag routes, with state: a write changes what the next
 * `candidate.info` answers, as in the tenant, and every write answers the
 * documented Candidate. The lane reads once more after its writes, so a static
 * answer would read as someone else having changed the tags.
 */
function candidateRoutes(initial: Array<ReturnType<typeof tag>>): Routes {
  let tags = [...initial];
  const known = [SELECT, BORDERLINE, REJECT, OTHER, ...initial];
  return {
    '/candidate.info': () => success(candidate(tags)),
    '/candidate.addTag': (body) => {
      const added = known.find((t) => t.id === body.tagId);
      if (added && !tags.some((t) => t.id === added.id)) tags = [...tags, added];
      return success(candidate(tags));
    },
    '/candidate.removeTag': (body) => {
      tags = tags.filter((t) => t.id !== body.tagId);
      return success(candidate(tags));
    },
  };
}

function json(status: number, body: unknown): AshbyTransportResponse {
  const text = JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text };
}
const success = (results: unknown, extra: Record<string, unknown> = {}) => json(200, { success: true, results, ...extra });

type Routes = Record<string, (body: Record<string, unknown>) => AshbyTransportResponse>;

function tenant(routes: Routes) {
  const requests: Array<{ path: string; body: Record<string, unknown>; raw: AshbyTransportRequest }> = [];
  const logs: AshbyLogRecord[] = [];
  const client = createAshbyClient({
    apiKey: 'SYNTHETIC_KEY',
    maxAttempts: 1,
    random: () => 0.5,
    sleep: async () => {},
    logger: { event: (r) => logs.push(r) },
    transport: async (req) => {
      const path = new URL(req.url).pathname;
      const body = JSON.parse(req.body) as Record<string, unknown>;
      requests.push({ path, body, raw: req });
      const route = routes[path];
      if (!route) throw new Error(`unexpected call to ${path}`);
      return route(body);
    },
  });
  return { client, requests, logs };
}

const claim: OperationClaimRow = {
  id: 'op-1',
  operationType: 'recommendation_tag',
  operationKey: `ashby:recommendation_tag:link-1:assessment-1`,
  applicationLinkId: 'link-1',
  leaseToken: 'lease-1',
  attempts: 1,
  maxAttempts: 5,
  marker: null,
  sourceSessionId: 'session-1',
  createdAt: '2026-11-04T00:00:00.000Z',
};

const link: WorkflowLinkRow = {
  id: 'link-1', externalApplicationId: APP_ID, externalJobId: 'job-1', jobMappingId: 'map-1',
  externalResumeFileHandle: null, candidateId: 'internal-1', sessionId: 'session-1', inviteId: null,
  lifecycle: 'writeback_pending', terminalState: null,
};

async function run(
  routes: Routes,
  source: Partial<RecommendationTagSource> = {},
  tagLink: RecommendationTagLink = { externalCandidateId: CAND_ID, externalApplicationId: APP_ID },
) {
  const t = tenant(routes);
  const record = {
    complete: [] as unknown[][],
    fail: [] as unknown[][],
    defer: [] as unknown[][],
    bound: [] as unknown[][],
    verdictAsked: [] as unknown[][],
  };
  const stores: RuntimeWorkflowStores = {
    findLinkByApplicationId: async () => null,
    createLink: async () => ({ id: 'link-1' }),
    advanceIngestion: async () => ({ status: 'ok' }),
    enqueueOperation: async () => ({ status: 'inserted', id: 'op' }),
    completeOperation: async (...args) => { record.complete.push(args); return 'ok'; },
    failOperation: async (...args) => { record.fail.push(args); return { outcome: 'failed' }; },
    deferOperation: async (...args) => { record.defer.push(args); return 'ok'; },
    claimOperation: async () => claim,
    parkOperationAwaitingDelivery: async () => 'ok',
    readIngestion: async () => null,
    readLink: async () => link,
    markWritebackPending: async () => ({ status: 'ok' }),
    bindLinkExternalCandidateId: async (...args) => { record.bound.push(args); },
    readRecommendationTagLink: async () => tagLink,
    readRecommendationTagSource: async (...args) => {
      record.verdictAsked.push(args);
      return { status: 'ok', recommendation: 'advance', evidenceGrade: 'decision', ...source };
    },
  };
  const result = await runClaimedAshbyOperation({
    stores,
    materialization: {} as never,
    resolveMappingForLink: async () => null,
    reissuePathFor: () => '/x',
    email: { providerApproved: false, domainVerified: false },
    owner: 'w1',
    leaseSeconds: 30,
    nowMs: () => Date.parse('2026-11-04T00:00:00.000Z'),
    recommendationTag: { client: t.client, resolver: createChristyTagResolver(t.client) },
  });
  return { ...t, record, result };
}

const catalogue = (results: unknown[]) => () => success(results, { moreDataAvailable: false, syncToken: 'sync-last-page' });

describe('the documented happy path', () => {
  it('reads the candidate, reads the catalogue, adds exactly the documented body, then looks again', async () => {
    const r = await run({
      ...candidateRoutes([OTHER]),
      '/candidateTag.list': catalogue([OTHER, SELECT, BORDERLINE, REJECT]),
    });
    expect(r.requests.map((q) => q.path)).toEqual([
      '/candidate.info', '/candidateTag.list', '/candidate.addTag', '/candidate.info',
    ]);
    // candidate.info names its identifier `id` on the wire.
    expect(r.requests[0].body).toEqual({ id: CAND_ID });
    expect(r.requests[1].body).toEqual({ includeArchived: false, limit: 100 });
    expect(r.requests[2].body).toEqual({ candidateId: CAND_ID, tagId: TAG_SELECT });
    expect(r.record.complete).toEqual([['op-1', 'lease-1', 'christy_tag_select', null]]);
    expect(r.result).toMatchObject({ committed: true, code: 'christy_tag_select' });
  });

  it('asks for the candidate-wide verdict with the link and the Ashby candidate id', async () => {
    const r = await run({ ...candidateRoutes([SELECT]) });
    expect(r.record.verdictAsked).toEqual([['link-1', CAND_ID]]);
  });

  it('a verdict change adds first, then removes only the old Christy tag', async () => {
    const r = await run(
      { ...candidateRoutes([OTHER, SELECT]), '/candidateTag.list': catalogue([OTHER, SELECT, BORDERLINE, REJECT]) },
      { recommendation: 'reject' },
    );
    expect(r.requests.map((q) => q.path)).toEqual([
      '/candidate.info', '/candidateTag.list', '/candidate.addTag', '/candidate.removeTag', '/candidate.info',
    ]);
    expect(r.requests[2].body).toEqual({ candidateId: CAND_ID, tagId: TAG_REJECT });
    expect(r.requests[3].body).toEqual({ candidateId: CAND_ID, tagId: TAG_SELECT });
    expect(r.result).toMatchObject({ committed: true, code: 'christy_tag_reject' });
  });

  it('walks a documented multi-page list, empty page included, passing the cursor back unchanged', async () => {
    const r = await run({
      ...candidateRoutes([]),
      '/candidateTag.list': (body) => {
        if (body.cursor === undefined) return success([OTHER], { moreDataAvailable: true, nextCursor: 'opaque/1==' });
        if (body.cursor === 'opaque/1==') return success([], { moreDataAvailable: true, nextCursor: 'opaque/2==' });
        return success([SELECT], { moreDataAvailable: false, syncToken: 'sync-last-page' });
      },
    });
    expect(r.requests.filter((q) => q.path === '/candidateTag.list').map((q) => q.body.cursor))
      .toEqual([undefined, 'opaque/1==', 'opaque/2==']);
    expect(r.result).toMatchObject({ code: 'christy_tag_select' });
  });

  it('a repeat calls candidate.info and nothing else', async () => {
    const r = await run({ '/candidate.info': () => success(candidate([OTHER, SELECT])) });
    expect(r.requests.map((q) => q.path)).toEqual(['/candidate.info']);
    expect(r.result).toMatchObject({ committed: true, code: 'christy_tag_select' });
  });

  it('a newest result with no verdict removes the Christy tag and leaves the other', async () => {
    const r = await run({ ...candidateRoutes([OTHER, BORDERLINE]) }, { recommendation: null });
    expect(r.requests.map((q) => q.path)).toEqual(['/candidate.info', '/candidate.removeTag', '/candidate.info']);
    expect(r.requests[1].body).toEqual({ candidateId: CAND_ID, tagId: TAG_BORDERLINE });
    expect(r.result).toMatchObject({ code: 'christy_tag_none' });
  });

  it('no result on any of the candidate\'s links is no tag', async () => {
    const r = await run({ ...candidateRoutes([REJECT]) }, { status: 'no_assessment', recommendation: null, evidenceGrade: null });
    expect(r.requests[1].body).toEqual({ candidateId: CAND_ID, tagId: TAG_REJECT });
    expect(r.result).toMatchObject({ committed: true, code: 'christy_tag_none' });
  });

  it('an untagged Candidate answered WITHOUT the tags key reads as no tags', async () => {
    // Live Ashby has already been seen leaving out a key the docs mark required
    // (ashby-candidate-info-contract.test.ts, resumeFileHandle). Pinned here.
    const untagged: Record<string, unknown> = { ...candidate([]) };
    delete untagged.tags;
    let tagged = false;
    const r = await run({
      '/candidate.info': () => success(tagged ? candidate([SELECT]) : untagged),
      '/candidateTag.list': catalogue([SELECT]),
      '/candidate.addTag': () => { tagged = true; return success(candidate([SELECT])); },
    });
    expect('tags' in untagged).toBe(false);
    expect(r.requests.map((q) => q.path)).toEqual([
      '/candidate.info', '/candidateTag.list', '/candidate.addTag', '/candidate.info',
    ]);
    expect(r.result).toMatchObject({ committed: true, code: 'christy_tag_select' });
  });

  it('a link with no stored candidate id reads it from a documented application.info, then asks for the verdict with it', async () => {
    const r = await run(
      {
        '/application.info': () => success({
          id: APP_ID,
          status: 'Active',
          job: { id: 'job-1', title: 'Synthetic' },
          currentInterviewStage: { id: 'stage-1' },
          candidate: { id: CAND_ID, name: 'Synthetic Person' },
        }),
        '/candidate.info': () => success(candidate([SELECT])),
      },
      {},
      { externalCandidateId: null, externalApplicationId: APP_ID },
    );
    expect(r.requests[0].body).toEqual({ applicationId: APP_ID });
    expect(r.record.bound).toEqual([['link-1', CAND_ID]]);
    expect(r.record.verdictAsked).toEqual([['link-1', CAND_ID]]);
    expect(r.result).toMatchObject({ committed: true });
  });
});

describe('the documented failures', () => {
  it('HTTP 403 on candidateTag.list (no Hiring Process read): permission fault, nothing written', async () => {
    const r = await run({
      '/candidate.info': () => success(candidate([])),
      '/candidateTag.list': () => json(403, { success: false, errorInfo: { code: 'missing_endpoint_permission' } }),
    });
    expect(r.record.defer).toEqual([['op-1', 'lease-1', 'ashby_tag_permission_denied', 3600]]);
    expect(r.requests.map((q) => q.path)).not.toContain('/candidate.addTag');
  });

  it('HTTP 403 on candidate.addTag (no Candidates write): permission fault', async () => {
    const r = await run({
      '/candidate.info': () => success(candidate([])),
      '/candidateTag.list': catalogue([SELECT]),
      '/candidate.addTag': () => json(403, { success: false }),
    });
    expect(r.record.defer).toEqual([['op-1', 'lease-1', 'ashby_tag_permission_denied', 3600]]);
    expect(r.record.fail).toEqual([]);
  });

  it('HTTP 200 with errorInfo missing_endpoint_permission: the same fault', async () => {
    const r = await run({
      '/candidate.info': () => json(200, { success: false, errorInfo: { code: 'missing_endpoint_permission', message: 'no', requestId: 'r' } }),
    });
    expect(r.record.defer).toEqual([['op-1', 'lease-1', 'ashby_tag_permission_denied', 3600]]);
  });

  it('a message-only refusal on a write re-reads, tries once more with a fresh id, then fails with the plain code', async () => {
    const r = await run({
      '/candidate.info': () => success(candidate([])),
      '/candidateTag.list': catalogue([SELECT]),
      '/candidate.addTag': () => json(200, { success: false, errors: [{ message: 'Synthetic Person cannot take this tag', parameter: 'tagId' }] }),
    });
    expect(r.requests.map((q) => q.path)).toEqual([
      '/candidate.info', '/candidateTag.list', '/candidate.addTag', '/candidate.info',
      '/candidateTag.list', '/candidate.addTag', '/candidate.info',
    ]);
    expect(r.record.fail).toEqual([['op-1', 'lease-1', 'ashby_tag_write_rejected', false]]);
    expect(JSON.stringify(r.record)).not.toContain('Synthetic Person');
  });

  it('a 503 is transient: deferred, attempt refunded, not failed', async () => {
    const r = await run({ '/candidate.info': () => json(503, {}) });
    expect(r.record.defer).toEqual([['op-1', 'lease-1', 'ashby_tag_transient', 300]]);
    expect(r.record.fail).toEqual([]);
  });

  it('a 429 is transient', async () => {
    const r = await run({
      '/candidate.info': () => success(candidate([])),
      '/candidateTag.list': () => json(429, {}),
    });
    expect(r.record.defer).toEqual([['op-1', 'lease-1', 'ashby_tag_transient', 300]]);
  });

  it('the admin renamed a tag: no write at all', async () => {
    const r = await run({
      '/candidate.info': () => success(candidate([])),
      '/candidateTag.list': catalogue([tag(TAG_SELECT, 'christy: select')]),
    });
    expect(r.record.defer).toEqual([['op-1', 'lease-1', 'ashby_tag_not_found', 3600]]);
    expect(r.requests.filter((q) => q.path === '/candidateTag.list')).toHaveLength(2);
  });
});

describe('what leaves the process', () => {
  it('sends HTTP Basic to the fixed origin, and the client log carries metadata only', async () => {
    const r = await run({
      ...candidateRoutes([]),
      '/candidateTag.list': catalogue([SELECT]),
    });
    expect(r.result).toMatchObject({ committed: true });
    for (const q of r.requests) {
      expect(q.raw.url.startsWith('https://api.ashbyhq.com/')).toBe(true);
      expect(q.raw.headers.authorization).toMatch(/^Basic /);
    }
    const logged = JSON.stringify(r.logs);
    for (const secret of [CAND_ID, TAG_SELECT, 'Christy', 'Synthetic']) {
      expect(logged).not.toContain(secret);
    }
  });
});
