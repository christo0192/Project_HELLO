/**
 * M035 S11 T2: the Ashby side of the "Dex R1: Booked" tag lane (`lib/r1/meet/ashby-booked-tag-ashby.ts`),
 * always through the REAL Ashby client over the stateful fake transport
 * (`support/r1-meet-ashby-tag-fake.ts`).
 *
 * - The one-title resolver (D-S11-5): paging (an empty middle page, the cursor passed back unchanged),
 *   the exact trimmed case-sensitive title, archived and unmarked entries skipped, found / not_found /
 *   ambiguous / truncated, the five-minute cache of complete walks, `fresh`, `invalidate()`, nothing
 *   cached from a truncated or failed walk, and one budget call per page.
 * - The port (D-S11-8): one attempt per call (a 429, a 503, a network failure and a timeout each make
 *   exactly ONE request), the exact write and list bodies, the five calls only and no `extra`, the
 *   metadata-only log lines, and an empty key refused before anything is built.
 * - The candidate's Dex tags and the holds rule (D-S11-6), the failure classes (D-S11-9) and the run
 *   budget (30 s, no call under 3 s).
 * - Across the whole file: no request path outside the five the lane may call.
 */
import { describe, expect, it } from 'vitest';
import { createAshbyClient } from '../integrations/ashby/client.js';
import { AshbyError, isAshbyError, type AshbyErrorCategory } from '../integrations/ashby/errors.js';
import type { CandidateTagListParams } from '../integrations/ashby/types.js';
import {
  R1_MEET_ASHBY_TAG_CLIENT_SETTINGS,
  R1_MEET_ASHBY_TAG_MAX_REMOVES,
  R1_MEET_ASHBY_TAG_MIN_CALL_MS,
  R1_MEET_ASHBY_TAG_RUN_MS,
  R1_MEET_BOOKED_TAG_CACHE_MS,
  R1_MEET_BOOKED_TAG_MAX_PAGES,
  R1_MEET_BOOKED_TAG_PAGE_SIZE,
  R1_MEET_BOOKED_TAG_TITLE,
  R1MeetAshbyTagMalformed,
  R1MeetAshbyTagOutOfTime,
  classifyR1MeetAshbyTagFailure,
  createR1MeetAshbyTagPort,
  createR1MeetBookedTagResolver,
  r1MeetAshbyTagBudget,
  r1MeetBookedTagHolds,
  r1MeetDexTagsOf,
  type R1MeetAshbyTagBudget,
  type R1MeetAshbyTagClient,
  type R1MeetAshbyTagFailureKind,
} from '../lib/r1/meet/ashby-booked-tag-ashby.js';
import { R1MeetJobError } from '../lib/r1/meet/jobs.js';
import type { R1MeetLog, R1MeetLogMeta } from '../lib/r1/meet/recall-actions.js';
import {
  ASHBY_TAG_LANE_PATHS,
  ASHBY_TAG_SENTINELS,
  createFakeAshbyTags,
  fakeAshbyTagKey,
  type FakeAshbyTags,
  type FakeTag,
} from './support/r1-meet-ashby-tag-fake.js';

const CANDIDATE = '7f000000-0000-4000-8000-0000000d1001';
const OTHER_CANDIDATE = '7f000000-0000-4000-8000-0000000d1002';
const APPLICATION = '7f000000-0000-4000-8000-0000000d2001';
const DEX_TAG = '7f000000-0000-4000-8000-0000000d3001';
const DEX_TAG_2 = '7f000000-0000-4000-8000-0000000d3002';
const CHRISTY_TAG = '7f000000-0000-4000-8000-0000000d3003';
const REFERRAL_TAG = '7f000000-0000-4000-8000-0000000d3004';
const NEAR_TAG = '7f000000-0000-4000-8000-0000000d3005';
const FIXTURE_IDS = [CANDIDATE, OTHER_CANDIDATE, APPLICATION, DEX_TAG, DEX_TAG_2, CHRISTY_TAG, REFERRAL_TAG, NEAR_TAG];

const TITLE = R1_MEET_BOOKED_TAG_TITLE;
const SAFE_CODE = /^[a-z0-9_.:-]{1,64}$/;
/** The logger's own rule for a string value (`lib/logger.ts`): a safe identifier of at most 64. */
const LOG_SAFE = /^[a-zA-Z0-9_:.-]{1,64}$/;
const START_MS = Date.parse('2030-01-01T10:00:00.000Z');

const dex = (id = DEX_TAG, over: Partial<FakeTag> = {}): FakeTag => ({ id, title: TITLE, isArchived: false, ...over });
const christy = (): FakeTag => ({ id: CHRISTY_TAG, title: 'Christy: Select', isArchived: false });
const referral = (): FakeTag => ({ id: REFERRAL_TAG, title: 'Referral', isArchived: false });

/** A page of `candidateTag.list` answered by script. */
const page = (results: unknown, more?: { readonly cursor?: string }) => ({
  status: 200,
  body: {
    success: true,
    results,
    moreDataAvailable: more !== undefined,
    ...(more?.cursor !== undefined ? { nextCursor: more.cursor } : {}),
  },
});

interface Line {
  readonly level: 'info' | 'warn' | 'error';
  readonly meta: R1MeetLogMeta;
}

const allFakes: FakeAshbyTags[] = [];
const allLines: Line[] = [];

/** A fake tenant, the REAL port over it, a settable clock and the captured log lines. */
function world() {
  const fake = createFakeAshbyTags();
  allFakes.push(fake);
  const lines: Line[] = [];
  const push = (level: Line['level']) => (meta: R1MeetLogMeta) => {
    lines.push({ level, meta });
    allLines.push({ level, meta });
  };
  const log: R1MeetLog = { info: push('info'), warn: push('warn'), error: push('error') };
  let now = START_MS;
  const sleeps: number[] = [];
  const port = createR1MeetAshbyTagPort({
    apiKey: fakeAshbyTagKey(),
    log,
    transport: fake.transport,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    nowMs: () => now,
  });
  return {
    fake,
    port,
    lines,
    log,
    sleeps,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

/** A catalogue of `count` other tags with the Dex tag at `dexAt` (state paging, 100 per page). */
function bigCatalogue(fake: FakeAshbyTags, count: number, dexAt: number): void {
  for (let i = 0; i < count; i++) {
    if (i === dexAt) fake.catalogue.push(dex());
    else fake.catalogue.push({ id: `7f000000-0000-4000-8000-0000000e${i.toString(16).padStart(4, '0')}`, title: `Team tag ${i}`, isArchived: false });
  }
}

async function ashbyFailure(promise: Promise<unknown>): Promise<AshbyError> {
  try {
    await promise;
  } catch (error) {
    if (isAshbyError(error)) return error;
    throw error;
  }
  throw new Error('expected an Ashby failure');
}

describe('the constants of the lane', () => {
  it('pins the title, the client settings, the cache, the paging and the run budget', () => {
    expect(R1_MEET_BOOKED_TAG_TITLE).toBe('Dex R1: Booked');
    expect(R1_MEET_ASHBY_TAG_CLIENT_SETTINGS).toEqual({ maxAttempts: 1, timeoutMs: 10_000 });
    expect(Object.isFrozen(R1_MEET_ASHBY_TAG_CLIENT_SETTINGS)).toBe(true);
    expect(R1_MEET_BOOKED_TAG_CACHE_MS).toBe(5 * 60_000);
    expect(R1_MEET_BOOKED_TAG_PAGE_SIZE).toBe(100);
    expect(R1_MEET_BOOKED_TAG_MAX_PAGES).toBe(100);
    expect(R1_MEET_ASHBY_TAG_RUN_MS).toBe(30_000);
    expect(R1_MEET_ASHBY_TAG_MIN_CALL_MS).toBe(3_000);
    expect(R1_MEET_ASHBY_TAG_MAX_REMOVES).toBe(5);
  });
});

describe('the one-title resolver (D-S11-5)', () => {
  it('finds the one active Dex tag on a single page, among other tags', async () => {
    const w = world();
    w.fake.catalogue.push(christy(), referral(), dex(), { id: NEAR_TAG, title: 'Dex R1: Booked (old)', isArchived: false });
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    expect(w.fake.paths()).toEqual(['/candidateTag.list']);
  });

  it('walks several pages, an EMPTY middle page included, passing each cursor back unchanged', async () => {
    const w = world();
    const first = 'opaque:A1/b+c=';
    const second = 'opaque:Z9_-.~';
    w.fake.next('/candidateTag.list', page([referral()], { cursor: first }));
    w.fake.next('/candidateTag.list', page([], { cursor: second }));
    w.fake.next('/candidateTag.list', page([christy(), dex()]));
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    const bodies = w.fake.requestsOf('/candidateTag.list').map((request) => request.body);
    expect(bodies).toEqual([
      { includeArchived: false, limit: 100 },
      { includeArchived: false, cursor: first, limit: 100 },
      { includeArchived: false, cursor: second, limit: 100 },
    ]);
  });

  it('walks the stateful catalogue 100 entries a page', async () => {
    const w = world();
    bigCatalogue(w.fake, 250, 220);
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    expect(w.fake.requestsOf('/candidateTag.list')).toHaveLength(3);
  });

  it('matches the exact title after a trim, never a case variant or a near title', async () => {
    const trimmed = world();
    trimmed.fake.catalogue.push(dex(DEX_TAG, { title: `  ${TITLE}\t` }));
    await expect(trimmed.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });

    for (const title of ['dex r1: booked', 'DEX R1: BOOKED', 'Dex R1: Booked (old)', 'Dex R1:  Booked', 'Dex R1 Booked', 'Dex R1: Booked.']) {
      const w = world();
      w.fake.catalogue.push(dex(DEX_TAG, { title }), christy());
      await expect(w.port.resolver.resolve(), title).resolves.toEqual({ status: 'not_found' });
    }
  });

  it('skips an archived entry and one that does not say it is active', async () => {
    const archived = world();
    archived.fake.ignoreIncludeArchived = true;
    archived.fake.catalogue.push(dex(DEX_TAG, { isArchived: true }));
    await expect(archived.port.resolver.resolve()).resolves.toEqual({ status: 'not_found' });
    // The tenant listed it (it ignored includeArchived:false); the resolver dropped it itself.
    expect(archived.fake.paths()).toEqual(['/candidateTag.list']);

    const unmarked = world();
    unmarked.fake.catalogue.push({ id: DEX_TAG, title: TITLE });
    await expect(unmarked.port.resolver.resolve()).resolves.toEqual({ status: 'not_found' });

    const both = world();
    both.fake.ignoreIncludeArchived = true;
    both.fake.catalogue.push(dex(DEX_TAG_2, { isArchived: true }), dex(DEX_TAG));
    await expect(both.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
  });

  it('drops entries without a usable id or title', async () => {
    const w = world();
    w.fake.next('/candidateTag.list', page([
      null,
      'not a tag',
      7,
      [DEX_TAG, TITLE],
      { id: '', title: TITLE, isArchived: false },
      { id: 5, title: TITLE, isArchived: false },
      { id: DEX_TAG_2, title: 5, isArchived: false },
      { id: DEX_TAG_2, isArchived: false },
      { id: DEX_TAG, title: TITLE, isArchived: false },
    ]));
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
  });

  it('answers ambiguous for two active ids, found for one id listed twice, not_found for none', async () => {
    const two = world();
    two.fake.catalogue.push(dex(DEX_TAG), dex(DEX_TAG_2));
    await expect(two.port.resolver.resolve()).resolves.toEqual({ status: 'ambiguous' });

    const twice = world();
    twice.fake.next('/candidateTag.list', page([dex(DEX_TAG)], { cursor: 'opaque-next' }));
    twice.fake.next('/candidateTag.list', page([dex(DEX_TAG)]));
    await expect(twice.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });

    const none = world();
    none.fake.catalogue.push(christy(), referral());
    await expect(none.port.resolver.resolve()).resolves.toEqual({ status: 'not_found' });

    const empty = world();
    await expect(empty.port.resolver.resolve()).resolves.toEqual({ status: 'not_found' });
  });

  it('answers truncated for results that are not a list, a repeated cursor and more data with no cursor', async () => {
    const notAList = world();
    notAList.fake.next('/candidateTag.list', page({ tags: [dex()] }));
    await expect(notAList.port.resolver.resolve()).resolves.toEqual({ status: 'truncated' });

    const repeated = world();
    repeated.fake.next('/candidateTag.list', page([referral()], { cursor: 'opaque-same' }));
    repeated.fake.next('/candidateTag.list', page([christy()], { cursor: 'opaque-same' }));
    await expect(repeated.port.resolver.resolve()).resolves.toEqual({ status: 'truncated' });
    expect(repeated.fake.requestsOf('/candidateTag.list')).toHaveLength(2);

    const noCursor = world();
    noCursor.fake.next('/candidateTag.list', page([dex()], {}));
    await expect(noCursor.port.resolver.resolve()).resolves.toEqual({ status: 'truncated' });
    expect(noCursor.fake.requestsOf('/candidateTag.list')).toHaveLength(1);
  });

  it('answers truncated at the 100-page cap, after exactly 100 page requests', async () => {
    const w = world();
    for (let i = 0; i < R1_MEET_BOOKED_TAG_MAX_PAGES + 5; i++) {
      w.fake.next('/candidateTag.list', page(i === 3 ? [dex()] : [], { cursor: `opaque-${i}` }));
    }
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'truncated' });
    expect(w.fake.requestsOf('/candidateTag.list')).toHaveLength(100);
  });

  it('reuses a complete walk for five minutes, then reads the catalogue again', async () => {
    const w = world();
    w.fake.catalogue.push(dex());
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    w.advance(R1_MEET_BOOKED_TAG_CACHE_MS - 1);
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: true });
    expect(w.fake.requestsOf('/candidateTag.list')).toHaveLength(1);
    w.advance(1);
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    expect(w.fake.requestsOf('/candidateTag.list')).toHaveLength(2);
  });

  it('caches a complete not_found too, so the caller reads once more with fresh', async () => {
    const w = world();
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'not_found' });
    w.fake.catalogue.push(dex());
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'not_found' });
    expect(w.fake.requestsOf('/candidateTag.list')).toHaveLength(1);
    await expect(w.port.resolver.resolve({ fresh: true })).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    expect(w.fake.requestsOf('/candidateTag.list')).toHaveLength(2);
  });

  it('fresh re-reads and refreshes the cache; invalidate drops it', async () => {
    const w = world();
    w.fake.catalogue.push(dex(DEX_TAG));
    await w.port.resolver.resolve();
    // The admin replaced the tag: the cache still answers the old id until a fresh read.
    w.fake.catalogue.splice(0, w.fake.catalogue.length, dex(DEX_TAG_2));
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: true });
    await expect(w.port.resolver.resolve({ fresh: true })).resolves.toEqual({ status: 'found', tagId: DEX_TAG_2, cached: false });
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG_2, cached: true });
    expect(w.fake.requestsOf('/candidateTag.list')).toHaveLength(2);

    w.port.resolver.invalidate();
    await expect(w.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG_2, cached: false });
    expect(w.fake.requestsOf('/candidateTag.list')).toHaveLength(3);
  });

  it('never caches a truncated walk or a failed one', async () => {
    const truncated = world();
    truncated.fake.catalogue.push(dex());
    truncated.fake.next('/candidateTag.list', page({ not: 'a list' }));
    await expect(truncated.port.resolver.resolve()).resolves.toEqual({ status: 'truncated' });
    await expect(truncated.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    expect(truncated.fake.requestsOf('/candidateTag.list')).toHaveLength(2);

    const failed = world();
    failed.fake.catalogue.push(dex());
    failed.fake.next('/candidateTag.list', { status: 503, body: { success: false } });
    const error = await ashbyFailure(failed.port.resolver.resolve());
    expect(classifyR1MeetAshbyTagFailure(error)?.kind).toBe('unavailable');
    await expect(failed.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    expect(failed.fake.requestsOf('/candidateTag.list')).toHaveLength(2);
  });

  it('spends one budget call per page and hands its deadline to each page request', async () => {
    const w = world();
    bigCatalogue(w.fake, 150, 120);
    const deadlines: number[] = [];
    const budget: R1MeetAshbyTagBudget = {
      beforeCall() {
        const deadlineAt = Date.now() + 20_000 + deadlines.length;
        deadlines.push(deadlineAt);
        return { deadlineAt };
      },
    };
    const seen: Array<CandidateTagListParams | undefined> = [];
    const resolver = createR1MeetBookedTagResolver({
      candidateTagList(params) {
        seen.push(params);
        return w.port.client.candidateTagList(params);
      },
    }, () => w.now());
    await expect(resolver.resolve({ budget })).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    expect(deadlines).toHaveLength(2);
    expect(seen.map((params) => params?.deadlineAt)).toEqual(deadlines);
    expect(seen.map((params) => params?.limit)).toEqual([100, 100]);
    // The deadline is internal: it never reaches the body Ashby receives.
    for (const request of w.fake.requestsOf('/candidateTag.list')) expect(request.body).not.toHaveProperty('deadlineAt');
  });

  it('stops before a page request once the budget is spent, and caches nothing', async () => {
    const spent = world();
    spent.fake.catalogue.push(dex());
    const budget = r1MeetAshbyTagBudget(() => spent.now());
    spent.advance(27_001);
    await expect(spent.port.resolver.resolve({ budget })).rejects.toBeInstanceOf(R1MeetAshbyTagOutOfTime);
    expect(spent.fake.requests).toHaveLength(0);

    const midWalk = world();
    bigCatalogue(midWalk.fake, 150, 120);
    const runBudget = r1MeetAshbyTagBudget(() => midWalk.now());
    let advanced = false;
    midWalk.fake.onRequest(() => {
      if (!advanced) {
        advanced = true;
        midWalk.advance(28_000);
      }
    });
    await expect(midWalk.port.resolver.resolve({ budget: runBudget })).rejects.toBeInstanceOf(R1MeetAshbyTagOutOfTime);
    expect(midWalk.fake.requestsOf('/candidateTag.list')).toHaveLength(1);
    await expect(midWalk.port.resolver.resolve()).resolves.toEqual({ status: 'found', tagId: DEX_TAG, cached: false });
    expect(midWalk.fake.requestsOf('/candidateTag.list')).toHaveLength(3);
  });
});

describe('the port (D-S11-8)', () => {
  it('is frozen and exposes exactly the five calls; the Ashby client satisfies the surface', () => {
    const w = world();
    expect(Object.isFrozen(w.port)).toBe(true);
    expect(Object.isFrozen(w.port.client)).toBe(true);
    expect(Object.keys(w.port.client).sort()).toEqual(
      ['applicationInfo', 'candidateAddTag', 'candidateInfo', 'candidateRemoveTag', 'candidateTagList'],
    );
    // Compile-time pin: the unchanged Ashby client is assignable to the lane's surface.
    const satisfied: R1MeetAshbyTagClient = createAshbyClient({ apiKey: fakeAshbyTagKey(), transport: w.fake.transport });
    expect(typeof satisfied.candidateTagList).toBe('function');
    expect(w.fake.requests).toHaveLength(0);
  });

  it('makes exactly ONE request on a 429, a 503, a network failure and a timeout (the queue retries)', async () => {
    const steps = [
      { step: { status: 429, headers: { 'retry-after': '1' } }, kind: 'rate_limited', detail: 'retry_exhausted:rate_limited', status: 429 },
      { step: { status: 503 }, kind: 'unavailable', detail: 'retry_exhausted:http_server_error', status: 503 },
      { step: 'network' as const, kind: 'unavailable', detail: 'retry_exhausted:network', status: null },
      { step: 'timeout' as const, kind: 'unavailable', detail: 'retry_exhausted:timeout', status: null },
    ];
    for (const { step, kind, detail, status } of steps) {
      const w = world();
      w.fake.candidates.set(CANDIDATE, []);
      w.fake.next('/candidate.info', step);
      const error = await ashbyFailure(w.port.client.candidateInfo(CANDIDATE));
      expect(w.fake.requests, detail).toHaveLength(1);
      expect(w.sleeps, detail).toEqual([]);
      expect(classifyR1MeetAshbyTagFailure(error), detail).toEqual({ kind, detail, httpStatus: status });
      // The error carries closed fields only.
      const serialized = JSON.stringify(error);
      for (const id of FIXTURE_IDS) expect(serialized).not.toContain(id);
    }
  });

  it('a tag write is one request too, and a refused one is not retried', async () => {
    const w = world();
    w.fake.candidates.set(CANDIDATE, []);
    w.fake.catalogue.push(dex());
    w.fake.next('/candidate.addTag', { status: 503 });
    const error = await ashbyFailure(w.port.client.candidateAddTag(CANDIDATE, DEX_TAG));
    expect(classifyR1MeetAshbyTagFailure(error)?.kind).toBe('unavailable');
    expect(w.fake.paths()).toEqual(['/candidate.addTag']);
    expect(w.fake.tagsOf(CANDIDATE)).toEqual([]);

    w.fake.next('/candidate.removeTag', { status: 200, body: { success: false, errors: ['tag_not_on_candidate'] } });
    const refusal = await ashbyFailure(w.port.client.candidateRemoveTag(CANDIDATE, DEX_TAG));
    expect(classifyR1MeetAshbyTagFailure(refusal)).toEqual({
      kind: 'rejected',
      detail: 'logical_failure:tag_not_on_candidate',
      httpStatus: 200,
    });
    expect(w.fake.paths()).toEqual(['/candidate.addTag', '/candidate.removeTag']);
  });

  it('sends exactly {candidateId, tagId} on the writes, {id} on candidate.info and {applicationId} on application.info', async () => {
    const w = world();
    w.fake.catalogue.push(dex(), christy());
    w.fake.candidates.set(CANDIDATE, [christy()]);
    w.fake.applications.set(APPLICATION, CANDIDATE);

    await w.port.client.applicationInfo(APPLICATION);
    await w.port.client.candidateInfo(CANDIDATE);
    await w.port.client.candidateAddTag(CANDIDATE, DEX_TAG);
    expect(w.fake.tagsOf(CANDIDATE)?.map((tag) => tag.id)).toEqual([CHRISTY_TAG, DEX_TAG]);
    await w.port.client.candidateRemoveTag(CANDIDATE, DEX_TAG);
    expect(w.fake.tagsOf(CANDIDATE)?.map((tag) => tag.id)).toEqual([CHRISTY_TAG]);

    expect(w.fake.requests.map((request) => [request.path, request.raw])).toEqual([
      ['/application.info', JSON.stringify({ applicationId: APPLICATION })],
      ['/candidate.info', JSON.stringify({ id: CANDIDATE })],
      ['/candidate.addTag', JSON.stringify({ candidateId: CANDIDATE, tagId: DEX_TAG })],
      ['/candidate.removeTag', JSON.stringify({ candidateId: CANDIDATE, tagId: DEX_TAG })],
    ]);
    // The key travels only as the Basic credential header (the fake redacts it).
    for (const request of w.fake.requests) expect(request.headers.authorization).toBe('<redacted>');
  });

  it('never forwards an extra field, even when a caller passes one past the types', async () => {
    const w = world();
    w.fake.candidates.set(CANDIDATE, []);
    w.fake.applications.set(APPLICATION, CANDIDATE);
    const untyped = w.port.client as unknown as {
      candidateInfo(id: string, extra: Record<string, unknown>): Promise<unknown>;
      applicationInfo(id: string, extra: Record<string, unknown>): Promise<unknown>;
    };
    await untyped.candidateInfo(CANDIDATE, { externalMappingId: 'x', id: OTHER_CANDIDATE });
    await untyped.applicationInfo(APPLICATION, { expand: ['openings'] });
    expect(w.fake.requests.map((request) => request.body)).toEqual([{ id: CANDIDATE }, { applicationId: APPLICATION }]);
  });

  it('lists the catalogue with {includeArchived:false, limit:100}, then the cursor', async () => {
    const w = world();
    bigCatalogue(w.fake, 120, 5);
    await w.port.resolver.resolve();
    const raws = w.fake.requestsOf('/candidateTag.list').map((request) => request.raw);
    expect(raws).toEqual([
      JSON.stringify({ includeArchived: false, limit: 100 }),
      JSON.stringify({ includeArchived: false, cursor: 'opaque-page-2s', limit: 100 }),
    ]);
  });

  it('logs closed words and a status only: no id, sentinel, title or key', async () => {
    const w = world();
    w.fake.catalogue.push(dex(), christy());
    w.fake.candidates.set(CANDIDATE, [christy()]);
    w.fake.applications.set(APPLICATION, CANDIDATE);
    await w.port.client.applicationInfo(APPLICATION);
    await w.port.client.candidateInfo(CANDIDATE);
    await w.port.resolver.resolve();
    await w.port.client.candidateAddTag(CANDIDATE, DEX_TAG);
    w.fake.next('/candidate.info', { status: 429 });
    await ashbyFailure(w.port.client.candidateInfo(CANDIDATE));
    await ashbyFailure(w.port.client.candidateAddTag(CANDIDATE, NEAR_TAG));
    w.fake.next('/candidate.removeTag', { status: 403, body: { success: false, errorInfo: { code: 'missing_endpoint_permission' } } });
    await ashbyFailure(w.port.client.candidateRemoveTag(CANDIDATE, DEX_TAG));

    expect(w.lines).toEqual([
      { level: 'info', meta: { error_category: 'r1_meet_ashby_ok', error_type: 'application.info', http_status: 200 } },
      { level: 'info', meta: { error_category: 'r1_meet_ashby_ok', error_type: 'candidate.info', http_status: 200 } },
      { level: 'info', meta: { error_category: 'r1_meet_ashby_ok', error_type: 'candidateTag.list', http_status: 200 } },
      { level: 'info', meta: { error_category: 'r1_meet_ashby_ok', error_type: 'candidate.addTag', http_status: 200 } },
      { level: 'warn', meta: { error_category: 'r1_meet_ashby_failed', error_type: 'candidate.info:rate_limited', http_status: 429 } },
      { level: 'warn', meta: { error_category: 'r1_meet_ashby_failed', error_type: 'candidate.addTag:logical_failure', http_status: 200 } },
      { level: 'warn', meta: { error_category: 'r1_meet_ashby_failed', error_type: 'candidate.removeTag:http_client_error', http_status: 403 } },
    ]);
    for (const line of w.lines) {
      expect(Object.keys(line.meta).every((key) => ['error_category', 'error_type', 'http_status'].includes(key))).toBe(true);
    }
  });

  it('refuses an empty key before anything is built', () => {
    const fake = createFakeAshbyTags();
    allFakes.push(fake);
    const log: R1MeetLog = { info: () => {}, warn: () => {}, error: () => {} };
    let thrown: unknown;
    try {
      createR1MeetAshbyTagPort({ apiKey: '', log, transport: fake.transport });
    } catch (error) {
      thrown = error;
    }
    expect(isAshbyError(thrown)).toBe(true);
    expect((thrown as AshbyError).category).toBe('invalid_request');
    expect((thrown as AshbyError).code).toBe('missing_api_key');
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the candidate's Dex tags (D-S11-6)", () => {
  it('reads an absent tags key as none, and refuses a shape it will not write from', () => {
    expect(r1MeetDexTagsOf({ id: CANDIDATE, name: ASHBY_TAG_SENTINELS.name })).toEqual([]);
    expect(r1MeetDexTagsOf({ tags: [] })).toEqual([]);
    for (const results of [null, undefined, [], [dex()], 'tags', 7, true]) {
      expect(() => r1MeetDexTagsOf(results), String(results)).toThrow(R1MeetAshbyTagMalformed);
    }
    for (const tags of [{}, null, 'Dex R1: Booked', 3, { 0: dex() }]) {
      expect(() => r1MeetDexTagsOf({ tags }), JSON.stringify(tags)).toThrow(R1MeetAshbyTagMalformed);
    }
    expect(new R1MeetAshbyTagMalformed().message).toBe('r1_meet_ashby_tag_malformed');
  });

  it('keeps only the Dex title (trimmed, any isArchived) and drops every other tag', () => {
    const tags = r1MeetDexTagsOf({
      tags: [
        christy(),
        referral(),
        { id: NEAR_TAG, title: 'Dex R1: Booked (old)', isArchived: false },
        { id: NEAR_TAG, title: 'dex r1: booked', isArchived: false },
        { id: DEX_TAG, title: `  ${TITLE} `, isArchived: false },
        { id: DEX_TAG_2, title: TITLE, isArchived: true },
        { id: '', title: TITLE, isArchived: false },
        { id: 7, title: TITLE, isArchived: false },
        { id: OTHER_CANDIDATE, title: null, isArchived: false },
        null,
        'Dex R1: Booked',
      ],
    });
    expect(tags).toEqual([
      { id: DEX_TAG, isArchived: false },
      { id: DEX_TAG_2, isArchived: true },
    ]);
  });

  it('reads a missing or odd isArchived as active, and an id listed twice once', () => {
    expect(r1MeetDexTagsOf({ tags: [{ id: DEX_TAG, title: TITLE }] })).toEqual([{ id: DEX_TAG, isArchived: false }]);
    expect(r1MeetDexTagsOf({ tags: [{ id: DEX_TAG, title: TITLE, isArchived: 'true' }] })).toEqual([{ id: DEX_TAG, isArchived: false }]);
    expect(r1MeetDexTagsOf({ tags: [dex(DEX_TAG, { isArchived: true }), dex(DEX_TAG)] })).toEqual([{ id: DEX_TAG, isArchived: false }]);
    expect(r1MeetDexTagsOf({ tags: [dex(DEX_TAG, { isArchived: true }), dex(DEX_TAG, { isArchived: true })] })).toEqual([
      { id: DEX_TAG, isArchived: true },
    ]);
  });

  it('reads the tags of a real candidate.info answer, without the name or the email', async () => {
    const w = world();
    w.fake.candidates.set(CANDIDATE, [christy(), dex(), referral()]);
    const tags = r1MeetDexTagsOf((await w.port.client.candidateInfo(CANDIDATE)).results);
    expect(tags).toEqual([{ id: DEX_TAG, isArchived: false }]);
    const kept = JSON.stringify(tags);
    expect(kept).not.toContain(ASHBY_TAG_SENTINELS.name);
    expect(kept).not.toContain(ASHBY_TAG_SENTINELS.email);
    expect(kept).not.toContain(CHRISTY_TAG);
  });

  it('holds when wanted only with an active Dex tag, and when not wanted only with no Dex tag at all', () => {
    const active = { id: DEX_TAG, isArchived: false };
    const archived = { id: DEX_TAG_2, isArchived: true };
    expect(r1MeetBookedTagHolds([active], true)).toBe(true);
    expect(r1MeetBookedTagHolds([archived, active], true)).toBe(true);
    expect(r1MeetBookedTagHolds([archived], true)).toBe(false);
    expect(r1MeetBookedTagHolds([], true)).toBe(false);
    expect(r1MeetBookedTagHolds([], false)).toBe(true);
    expect(r1MeetBookedTagHolds([archived], false)).toBe(false);
    expect(r1MeetBookedTagHolds([active], false)).toBe(false);
  });
});

describe('the failure classes (D-S11-9)', () => {
  const cases: Array<{
    readonly name: string;
    readonly error: AshbyError;
    readonly kind: R1MeetAshbyTagFailureKind;
    readonly detail: string;
    readonly httpStatus: number | null;
  }> = [
    { name: '401', error: new AshbyError('http_client_error', { httpStatus: 401 }), kind: 'permission', detail: 'permission_denied', httpStatus: 401 },
    { name: '403', error: new AshbyError('http_client_error', { httpStatus: 403 }), kind: 'permission', detail: 'permission_denied', httpStatus: 403 },
    {
      name: '403 with the module code',
      error: new AshbyError('http_client_error', { httpStatus: 403, endpointCodes: ['missing_endpoint_permission'] }),
      kind: 'permission', detail: 'permission_denied', httpStatus: 403,
    },
    {
      name: '200 missing_endpoint_permission',
      error: new AshbyError('logical_failure', { httpStatus: 200, endpointCodes: ['missing_endpoint_permission'] }),
      kind: 'permission', detail: 'permission_denied', httpStatus: 200,
    },
    {
      name: '200 MISSING_ENDPOINT_PERMISSION',
      error: new AshbyError('logical_failure', { httpStatus: 200, endpointCodes: ['other_code', 'MISSING_ENDPOINT_PERMISSION'] }),
      kind: 'permission', detail: 'permission_denied', httpStatus: 200,
    },
    { name: '429', error: new AshbyError('rate_limited', { httpStatus: 429 }), kind: 'rate_limited', detail: 'rate_limited', httpStatus: 429 },
    {
      name: 'retry_exhausted 429',
      error: new AshbyError('retry_exhausted', { httpStatus: 429, code: 'rate_limited' }),
      kind: 'rate_limited', detail: 'retry_exhausted:rate_limited', httpStatus: 429,
    },
    { name: '500', error: new AshbyError('http_server_error', { httpStatus: 500 }), kind: 'unavailable', detail: 'http_server_error', httpStatus: 500 },
    { name: 'timeout', error: new AshbyError('timeout', {}), kind: 'unavailable', detail: 'timeout', httpStatus: null },
    { name: 'network', error: new AshbyError('network', {}), kind: 'unavailable', detail: 'network', httpStatus: null },
    {
      name: 'malformed_response',
      error: new AshbyError('malformed_response', { httpStatus: 200, code: 'invalid_json' }),
      kind: 'unavailable', detail: 'malformed_response', httpStatus: 200,
    },
    { name: 'output_limit', error: new AshbyError('output_limit', { httpStatus: 200 }), kind: 'unavailable', detail: 'output_limit', httpStatus: 200 },
    {
      name: 'retry_exhausted 503',
      error: new AshbyError('retry_exhausted', { httpStatus: 503, code: 'http_server_error' }),
      kind: 'unavailable', detail: 'retry_exhausted:http_server_error', httpStatus: 503,
    },
    { name: '404', error: new AshbyError('http_client_error', { httpStatus: 404 }), kind: 'rejected', detail: 'http_client_error', httpStatus: 404 },
    {
      name: '400 with a code',
      error: new AshbyError('http_client_error', { httpStatus: 400, endpointCodes: ['Invalid_Input'] }),
      kind: 'rejected', detail: 'http_client_error:invalid_input', httpStatus: 400,
    },
    {
      name: 'logical_failure with a code',
      error: new AshbyError('logical_failure', { httpStatus: 200, endpointCodes: ['tag_not_found'] }),
      kind: 'rejected', detail: 'logical_failure:tag_not_found', httpStatus: 200,
    },
    { name: 'plain logical_failure', error: new AshbyError('logical_failure', { httpStatus: 200 }), kind: 'rejected', detail: 'logical_failure', httpStatus: 200 },
    {
      name: 'invalid_request',
      error: new AshbyError('invalid_request', { code: 'invalid_id', operation: 'candidate.info' }),
      kind: 'request_invalid', detail: 'invalid_request', httpStatus: null,
    },
  ];

  for (const { name, error, kind, detail, httpStatus } of cases) {
    it(`${name} -> ${kind}`, () => {
      const failure = classifyR1MeetAshbyTagFailure(error);
      expect(failure).toEqual({ kind, detail, httpStatus });
      expect(failure?.detail).toMatch(SAFE_CODE);
    });
  }

  it('covers every category of the client taxonomy', () => {
    const covered = new Set<AshbyErrorCategory>(cases.map((entry) => entry.error.category));
    const all: AshbyErrorCategory[] = [
      'invalid_request', 'logical_failure', 'http_client_error', 'rate_limited', 'http_server_error',
      'malformed_response', 'timeout', 'network', 'output_limit', 'retry_exhausted',
    ];
    expect([...covered].sort()).toEqual([...all].sort());
  });

  it('answers unavailable for our malformed answer and the out-of-time stop', () => {
    expect(classifyR1MeetAshbyTagFailure(new R1MeetAshbyTagMalformed())).toEqual({
      kind: 'unavailable', detail: 'malformed_response', httpStatus: null,
    });
    expect(classifyR1MeetAshbyTagFailure(new R1MeetAshbyTagOutOfTime())).toEqual({
      kind: 'unavailable', detail: 'out_of_time', httpStatus: null,
    });
  });

  it('answers null for anything that is not an Ashby failure, so the caller rethrows it', () => {
    for (const error of [new Error('boom'), new R1MeetJobError('r1_meet_db_error'), new TypeError('x'), 'ashby_timeout', null, undefined, { category: 'timeout' }]) {
      expect(classifyR1MeetAshbyTagFailure(error)).toBeNull();
    }
  });

  it('classifies what the REAL client throws: a 403, a 200 errorInfo permission code and a 404', async () => {
    const w = world();
    w.fake.candidates.set(CANDIDATE, []);
    w.fake.catalogue.push(dex());
    w.fake.next('/candidate.addTag', { status: 403, body: { success: false } });
    expect(classifyR1MeetAshbyTagFailure(await ashbyFailure(w.port.client.candidateAddTag(CANDIDATE, DEX_TAG)))).toEqual({
      kind: 'permission', detail: 'permission_denied', httpStatus: 403,
    });
    w.fake.next('/candidateTag.list', { status: 200, body: { success: false, errorInfo: { code: 'missing_endpoint_permission' } } });
    expect(classifyR1MeetAshbyTagFailure(await ashbyFailure(w.port.resolver.resolve()))).toEqual({
      kind: 'permission', detail: 'permission_denied', httpStatus: 200,
    });
    w.fake.next('/candidate.info', { status: 404, body: { success: false, errors: ['not_found'] } });
    expect(classifyR1MeetAshbyTagFailure(await ashbyFailure(w.port.client.candidateInfo(CANDIDATE)))).toEqual({
      kind: 'rejected', detail: 'http_client_error:not_found', httpStatus: 404,
    });
    expect(classifyR1MeetAshbyTagFailure(await ashbyFailure(w.port.client.candidateInfo('')))).toEqual({
      kind: 'request_invalid', detail: 'invalid_request', httpStatus: null,
    });
    expect(w.fake.paths()).toEqual(['/candidate.addTag', '/candidateTag.list', '/candidate.info']);
  });
});

describe('the run budget (D-S11-8)', () => {
  it('refuses no call on a static clock and hands each call the time left', () => {
    const now = 5_000;
    const budget = r1MeetAshbyTagBudget(() => now);
    for (let i = 0; i < 10; i++) budget.beforeCall();
    const before = Date.now();
    const { deadlineAt } = budget.beforeCall();
    const after = Date.now();
    expect(deadlineAt).toBeGreaterThanOrEqual(before + R1_MEET_ASHBY_TAG_RUN_MS);
    expect(deadlineAt).toBeLessThanOrEqual(after + R1_MEET_ASHBY_TAG_RUN_MS);
  });

  it('allows a call with exactly 3 s left and refuses one after 27_001 ms', () => {
    let now = 0;
    const budget = r1MeetAshbyTagBudget(() => now);
    now += 27_000;
    const { deadlineAt } = budget.beforeCall();
    expect(Math.abs((deadlineAt as number) - Date.now() - 3_000)).toBeLessThan(50);
    now += 1;
    expect(() => budget.beforeCall()).toThrow(R1MeetAshbyTagOutOfTime);
    expect(() => budget.beforeCall()).toThrow('r1_meet_ashby_tag_out_of_time');

    let later = 0;
    const fresh = r1MeetAshbyTagBudget(() => later);
    later += 27_001;
    expect(() => fresh.beforeCall()).toThrow(R1MeetAshbyTagOutOfTime);
  });

  it('starts at creation: a budget made later has its own 30 s', () => {
    let now = 0;
    const early = r1MeetAshbyTagBudget(() => now);
    now += 20_000;
    const late = r1MeetAshbyTagBudget(() => now);
    now += 8_000;
    expect(() => early.beforeCall()).toThrow(R1MeetAshbyTagOutOfTime);
    const { deadlineAt } = late.beforeCall();
    expect(Math.abs((deadlineAt as number) - Date.now() - 22_000)).toBeLessThan(50);
  });

  it('fails closed on a clock that answers no finite time', () => {
    const broken = r1MeetAshbyTagBudget(() => Number.NaN);
    expect(() => broken.beforeCall()).toThrow(R1MeetAshbyTagOutOfTime);
  });

  it("cuts a real call off at the run's end (the client sees the carried deadline)", async () => {
    const w = world();
    w.fake.candidates.set(CANDIDATE, [dex()]);
    const budget = r1MeetAshbyTagBudget(() => w.now());
    const options = budget.beforeCall();
    const tags = r1MeetDexTagsOf((await w.port.client.candidateInfo(CANDIDATE, undefined, options)).results);
    expect(tags).toEqual([{ id: DEX_TAG, isArchived: false }]);
    // A deadline already past: the client refuses to start the call at all.
    const error = await ashbyFailure(w.port.client.candidateInfo(CANDIDATE, undefined, { deadlineAt: Date.now() - 1 }));
    expect(classifyR1MeetAshbyTagFailure(error)?.kind).toBe('unavailable');
    expect(w.fake.requests).toHaveLength(1);
  });
});

describe('across the whole file', () => {
  it('calls only the five paths of the lane, and never a create', () => {
    const paths = allFakes.flatMap((fake) => fake.paths());
    expect(paths.length).toBeGreaterThan(100);
    const allowed = new Set<string>(ASHBY_TAG_LANE_PATHS);
    expect(paths.filter((path) => !allowed.has(path))).toEqual([]);
    expect(paths.some((path) => /create/i.test(path))).toBe(false);
  });

  it('logs no fixture id, sentinel, title or key anywhere in the file', () => {
    expect(allLines.length).toBeGreaterThan(50);
    const text = JSON.stringify(allLines);
    for (const id of FIXTURE_IDS) expect(text).not.toContain(id);
    expect(text).not.toContain(ASHBY_TAG_SENTINELS.name);
    expect(text).not.toContain(ASHBY_TAG_SENTINELS.email);
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(fakeAshbyTagKey());
    expect(text).not.toContain(Buffer.from(`${fakeAshbyTagKey()}:`, 'utf8').toString('base64'));
    for (const { meta } of allLines) {
      expect(meta.error_category).toMatch(LOG_SAFE);
      if (meta.error_type !== undefined) expect(meta.error_type).toMatch(LOG_SAFE);
    }
  });
});
