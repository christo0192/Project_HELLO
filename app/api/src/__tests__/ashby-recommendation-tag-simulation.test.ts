/**
 * ashby-recommendation-tag-simulation.test.ts — the whole flow on a fake tenant.
 *
 *   assessment lands ─► REAL completion observer ─► in-memory outbox
 *   ─► REAL `runAshbyOperationPass` ─► REAL AshbyClient ─► fake Ashby tenant
 *
 * The tenant keeps real state (a tag catalogue, a tag set per candidate), so what
 * is asserted is what a recruiter would see in Ashby. The outbox mirrors the 0134
 * rules the lane depends on: per-revision keys, `order by scheduled_at, id`,
 * defer rescheduling, and terminal links not being claimable. Those rules are
 * proven against real Postgres in policy_tests.sql section 0134.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAshbyClient } from '../integrations/ashby/client.js';
import { observeAshbyCompletion } from '../integrations/ashby/completion-observer.js';
import { runAshbyOperationPass } from '../integrations/ashby/operation-worker.js';
import {
  createChristyTagResolver,
  recommendationTagsEnabled,
  TAG_DEFER_AGE_LIMIT_MS,
} from '../integrations/ashby/recommendation-tags.js';
import type { OperationClaimRow, RuntimeWorkflowStores } from '../integrations/ashby/orchestration.js';

const TITLES = { select: 'Christy: Select', borderline: 'Christy: Borderline', reject: 'Christy: Reject' };

/** The fake Ashby tenant. Failure knobs let a scenario take it down. */
class FakeTenant {
  catalogue = [
    { id: 'tag-select', title: TITLES.select, isArchived: false },
    { id: 'tag-borderline', title: TITLES.borderline, isArchived: false },
    { id: 'tag-reject', title: TITLES.reject, isArchived: false },
    { id: 'tag-vip', title: 'VIP', isArchived: false },
    { id: 'tag-old', title: 'Christy: Select', isArchived: true },
  ];
  candidates = new Map<string, Set<string>>();
  applications = new Map<string, string>();
  writes: string[] = [];
  /** Tag counts seen after each write, to prove add-before-remove. */
  christyCountsAfterWrite: number[] = [];
  failStatus: number | null = null;
  denyList = false;

  private json(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text };
  }

  private publicTags(candidateId: string) {
    return [...(this.candidates.get(candidateId) ?? new Set<string>())].map((id) => this.catalogue.find((t) => t.id === id)!);
  }

  christyTitlesOn(candidateId: string): string[] {
    return this.publicTags(candidateId).map((t) => t.title).filter((t) => t.startsWith('Christy: ')).sort();
  }

  tagIdsOn(candidateId: string): string[] {
    return [...(this.candidates.get(candidateId) ?? new Set<string>())].sort();
  }

  transport = async (req: { url: string; body: string }) => {
    const route = new URL(req.url).pathname;
    const body = JSON.parse(req.body) as Record<string, string>;
    if (this.failStatus !== null) return this.json(this.failStatus, {});
    switch (route) {
      case '/candidate.info':
        return this.json(200, { success: true, results: { id: body.id, tags: this.publicTags(body.id) } });
      case '/application.info':
        return this.json(200, {
          success: true,
          results: { id: body.applicationId, candidate: { id: this.applications.get(body.applicationId), name: 'Synthetic' } },
        });
      case '/candidateTag.list': {
        if (this.denyList) return this.json(403, {});
        const active = this.catalogue.filter((t) => !t.isArchived);
        // Two pages with an empty one between, as Ashby may answer.
        if (!body.cursor) return this.json(200, { success: true, results: active.slice(0, 1), moreDataAvailable: true, nextCursor: 'p2' });
        if (body.cursor === 'p2') return this.json(200, { success: true, results: [], moreDataAvailable: true, nextCursor: 'p3' });
        return this.json(200, { success: true, results: active.slice(1), moreDataAvailable: false });
      }
      case '/candidate.addTag':
      case '/candidate.removeTag': {
        const set = this.candidates.get(body.candidateId) ?? new Set<string>();
        this.candidates.set(body.candidateId, set);
        if (route === '/candidate.addTag') set.add(body.tagId);
        else set.delete(body.tagId);
        this.writes.push(`${route === '/candidate.addTag' ? 'add' : 'remove'}:${body.candidateId}:${body.tagId}`);
        this.christyCountsAfterWrite.push(this.christyTitlesOn(body.candidateId).length);
        return this.json(200, { success: true, results: { id: body.candidateId, tags: this.publicTags(body.candidateId) } });
      }
      default:
        throw new Error(`unexpected call to ${route}`);
    }
  };
}

interface SimOp {
  id: string;
  type: string;
  key: string;
  linkId: string;
  sessionId: string | null;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  anchor: string | null;
  errorCode: string | null;
  lease: string | null;
  scheduledAt: number;
  createdAt: number;
}

interface SimLink {
  id: string;
  applicationId: string;
  candidateId: string | null;
  terminal: 'withdrawn' | null;
}

/** The in-memory outbox and tables. */
class SimDb {
  clock = Date.parse('2026-11-04T00:00:00.000Z');
  private seq = 0;
  links = new Map<string, SimLink>();
  assessments: Array<{ id: string; sessionId: string; recommendation: string | null; grade: 'decision' | 'insufficient' | null; at: number }> = [];
  ops: SimOp[] = [];

  addLink(id: string, applicationId: string, candidateId: string | null) {
    this.links.set(id, { id, applicationId, candidateId, terminal: null });
  }

  /** One assessment revision lands. Time moves, so the newest is unambiguous. */
  assess(sessionId: string, recommendation: string | null, grade: 'decision' | 'insufficient' | null = 'decision') {
    this.clock += 1000;
    this.assessments.push({ id: `assessment-${++this.seq}`, sessionId, recommendation, grade, at: this.clock });
  }

  private newest(sessionId: string) {
    return this.assessments.filter((a) => a.sessionId === sessionId).sort((a, b) => b.at - a.at)[0];
  }

  enqueueTag(linkId: string, sessionId: string): { status: string } {
    const link = this.links.get(linkId);
    if (!link) return { status: 'not_found' };
    if (link.terminal) return { status: 'blocked_terminal' };
    const a = this.newest(sessionId);
    if (!a) return { status: 'assessment_missing' };
    const key = `ashby:recommendation_tag:${linkId}:${a.id}`;
    if (this.ops.some((o) => o.key === key)) return { status: 'duplicate' };
    this.ops.push({
      id: `op-${++this.seq}`, type: 'recommendation_tag', key, linkId, sessionId,
      state: 'pending', anchor: null, errorCode: null, lease: null,
      scheduledAt: this.clock, createdAt: this.clock,
    });
    return { status: 'inserted' };
  }

  tagOps(linkId?: string) {
    return this.ops.filter((o) => o.type === 'recommendation_tag' && (!linkId || o.linkId === linkId));
  }

  stores(): RuntimeWorkflowStores {
    const op = (id: string, lease: string) => this.ops.find((o) => o.id === id && o.lease === lease && o.state === 'running');
    return {
      findLinkByApplicationId: async () => null,
      createLink: async () => ({ id: 'x' }),
      advanceIngestion: async () => ({ status: 'ok' }),
      enqueueOperation: async () => ({ status: 'inserted', id: 'x' }),
      parkOperationAwaitingDelivery: async () => 'ok',
      readIngestion: async () => null,
      markWritebackPending: async () => ({ status: 'ok' }),
      enqueueScorecardWrite: async () => ({ status: 'inserted' }),
      enqueueRecommendationTag: async (linkId, sessionId) =>
        // The production store's gate, against the in-memory outbox.
        recommendationTagsEnabled() ? this.enqueueTag(linkId, sessionId) : { status: 'disabled' },
      claimOperation: async (type) => {
        const next = this.ops
          .filter((o) => o.type === type && o.state === 'pending' && o.scheduledAt <= this.clock
            && !this.links.get(o.linkId)?.terminal)
          .sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id, 'en', { numeric: true }))[0];
        if (!next) return null;
        next.state = 'running';
        next.lease = `lease-${next.id}`;
        const claim: OperationClaimRow = {
          id: next.id,
          operationType: next.type as OperationClaimRow['operationType'],
          operationKey: next.key,
          applicationLinkId: next.linkId,
          leaseToken: next.lease,
          attempts: 1,
          maxAttempts: 5,
          marker: null,
          sourceSessionId: next.sessionId,
          createdAt: new Date(next.createdAt).toISOString(),
        };
        return claim;
      },
      readLink: async (id) => {
        const l = this.links.get(id);
        return l
          ? {
              id: l.id, externalApplicationId: l.applicationId, externalJobId: 'job', jobMappingId: 'map',
              externalResumeFileHandle: null, candidateId: 'internal', sessionId: null, inviteId: null,
              lifecycle: 'writeback_pending', terminalState: l.terminal,
            }
          : null;
      },
      bindLinkExternalCandidateId: async (id, candidateId) => {
        const l = this.links.get(id);
        if (l && !l.candidateId) l.candidateId = candidateId;
      },
      readRecommendationTagSource: async (linkId, sessionId) => {
        const l = this.links.get(linkId);
        const a = sessionId ? this.newest(sessionId) : undefined;
        if (!l || !a) return null;
        const newestOp = this.tagOps(linkId).sort((x, y) => y.createdAt - x.createdAt || y.id.localeCompare(x.id, 'en', { numeric: true }))[0];
        return {
          externalCandidateId: l.candidateId,
          externalApplicationId: l.applicationId,
          recommendation: a.recommendation,
          evidenceGrade: a.grade,
          isNewestTagOperation: (id) => id === newestOp?.id,
        };
      },
      completeOperation: async (id, lease, anchor) => {
        const o = op(id, lease);
        if (!o) return 'not_owned';
        o.state = 'succeeded';
        o.anchor = anchor ?? null;
        o.errorCode = null;
        return 'ok';
      },
      failOperation: async (id, lease, code, retryable) => {
        const o = op(id, lease);
        if (!o) return 'not_owned';
        o.errorCode = code;
        o.state = retryable ? 'pending' : 'failed';
        return { outcome: retryable ? 'retry' : 'failed' };
      },
      deferOperation: async (id, lease, code, seconds) => {
        const o = op(id, lease);
        if (!o) return 'not_owned';
        o.errorCode = code;
        o.state = 'pending';
        o.scheduledAt = this.clock + seconds * 1000;
        return 'ok';
      },
    };
  }
}

function world() {
  const tenant = new FakeTenant();
  const db = new SimDb();
  const client = createAshbyClient({
    apiKey: 'SYNTHETIC_KEY',
    transport: tenant.transport,
    random: () => 0.5,
    sleep: async () => {},
  });
  const resolver = createChristyTagResolver(client, () => db.clock);
  const stores = db.stores();
  const nowMs = () => db.clock;

  /** One scheduler tick. The runtime's kill-switch wiring, then the real pass. */
  const tick = () =>
    runAshbyOperationPass({
      stores,
      materialization: {} as never,
      resolveMappingForLink: async () => null,
      reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false },
      owner: 'sim',
      leaseSeconds: 30,
      nowMs,
      ...(recommendationTagsEnabled() ? { recommendationTag: { client, resolver } } : {}),
    });
  /** Ticks until the queue has nothing due. */
  const drain = async () => {
    for (let i = 0; i < 50; i++) {
      const r = await tick();
      if (!r.invite.claimed && !r.scorecard.claimed && !r.recommendationTag.claimed) return;
    }
    throw new Error('the queue did not drain');
  };
  /** An assessment lands and the real observer runs. */
  const complete = async (linkId: string, sessionId: string, recommendation: string | null, grade: 'decision' | 'insufficient' | null = 'decision') => {
    db.assess(sessionId, recommendation, grade);
    return observeAshbyCompletion(
      sessionId,
      { lookup: { findLinkBySessionId: async () => ({ id: linkId, terminalState: db.links.get(linkId)?.terminal ?? null }) }, stores },
      { evidenceGrade: grade },
    );
  };
  return { tenant, db, tick, drain, complete };
}

const CAND = 'cand-1';

describe('the flow on a fake tenant', () => {
  beforeEach(() => vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('a new verdict tags the candidate, and a second pass writes nothing', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    await w.drain();
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.select]);
    expect(w.db.tagOps()[0]).toMatchObject({ state: 'succeeded', anchor: 'christy_tag_select' });

    const writes = w.tenant.writes.length;
    await w.complete('link-1', 'session-1', 'advance'); // a rescore, same verdict
    await w.drain();
    expect(w.tenant.writes.length).toBe(writes);
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.select]);
  });

  it('a rescore changes the verdict: one tag at the end, and never none in between', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    await w.drain();
    await w.complete('link-1', 'session-1', 'reject');
    await w.drain();
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.reject]);
    expect(w.tenant.christyCountsAfterWrite.every((n) => n >= 1)).toBe(true);
    expect(w.tenant.writes.at(-2)).toBe(`add:${CAND}:tag-reject`);
    expect(w.tenant.writes.at(-1)).toBe(`remove:${CAND}:tag-select`);
  });

  it('a re-screen on a new session moves the tag to the new verdict', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'reject');
    await w.drain();
    await w.complete('link-1', 'session-2', 'hold');
    await w.drain();
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.borderline]);
  });

  it('two results before the lane runs: the older operation is superseded, with no Ashby write', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    await w.complete('link-1', 'session-2', 'reject');
    await w.drain();
    const [older, newer] = w.db.tagOps();
    expect(older).toMatchObject({ state: 'succeeded', anchor: 'christy_tag_superseded' });
    expect(newer).toMatchObject({ state: 'succeeded', anchor: 'christy_tag_reject' });
    expect(w.tenant.writes).toEqual([`add:${CAND}:tag-reject`]);
  });

  it('a newer result with no verdict takes the old tag off and adds none', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    await w.drain();
    await w.complete('link-1', 'session-2', null);
    await w.drain();
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([]);
    expect(w.db.tagOps().at(-1)).toMatchObject({ anchor: 'christy_tag_none' });
  });

  it('a newer insufficient-evidence result takes the old tag off too', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    await w.drain();
    const outcome = await w.complete('link-1', 'session-2', 'advance', 'insufficient');
    expect(outcome.status).toBe('held_insufficient_evidence');
    await w.drain();
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([]);
  });

  it('a provisional Reject is tagged Reject', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    // Provisional: incomplete_evidence with a verdict, graded decision. The lane
    // reads only the verdict and the grade.
    await w.complete('link-1', 'session-1', 'reject', 'decision');
    await w.drain();
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.reject]);
  });

  it('a recruiter tag survives every change', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    w.tenant.candidates.set(CAND, new Set(['tag-vip']));
    await w.complete('link-1', 'session-1', 'advance');
    await w.drain();
    await w.complete('link-1', 'session-2', 'hold');
    await w.drain();
    await w.complete('link-1', 'session-3', null);
    await w.drain();
    expect(w.tenant.tagIdsOn(CAND)).toEqual(['tag-vip']);
    expect(w.tenant.writes.some((x) => x.includes('tag-vip'))).toBe(false);
  });

  it('an older link with no stored candidate id binds it from application.info', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', null);
    w.tenant.applications.set('app-1', CAND);
    await w.complete('link-1', 'session-1', 'hold');
    await w.drain();
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.borderline]);
    expect(w.db.links.get('link-1')?.candidateId).toBe(CAND);
  });

  it('backfill order: a candidate in two jobs ends on the newest verdict', async () => {
    const w = world();
    w.db.addLink('link-old', 'app-old', CAND);
    w.db.addLink('link-new', 'app-new', CAND);
    w.db.assess('session-old', 'reject');
    w.db.assess('session-new', 'advance');
    // The backfill walks oldest scorecard first and schedules each insert one
    // millisecond after the last. Ids are made to sort the WRONG way round, so
    // only `scheduled_at` can give the right answer.
    expect(w.db.enqueueTag('link-old', 'session-old').status).toBe('inserted');
    expect(w.db.enqueueTag('link-new', 'session-new').status).toBe('inserted');
    const [oldOp, newOp] = w.db.tagOps();
    [oldOp.id, newOp.id] = [newOp.id, oldOp.id];
    oldOp.scheduledAt = w.db.clock + 1;
    newOp.scheduledAt = w.db.clock + 2;
    w.db.clock += 10;
    await w.drain();
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.select]);
    expect(w.tenant.writes).toEqual([
      `add:${CAND}:tag-reject`,
      `add:${CAND}:tag-select`,
      `remove:${CAND}:tag-reject`,
    ]);
  });

  it('a backfill re-run is idempotent', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    w.db.assess('session-1', 'advance');
    expect(w.db.enqueueTag('link-1', 'session-1').status).toBe('inserted');
    await w.drain();
    expect(w.db.enqueueTag('link-1', 'session-1').status).toBe('duplicate');
    await w.drain();
    expect(w.tenant.writes).toEqual([`add:${CAND}:tag-select`]);
  });

  it('a withdrawn application gets nothing new and a pending tag is not run', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    w.db.links.get('link-1')!.terminal = 'withdrawn';
    await w.drain();
    expect(w.tenant.writes).toEqual([]);
    const outcome = await w.complete('link-1', 'session-2', 'hold');
    expect(outcome.status).toBe('blocked_terminal');
    expect(w.db.tagOps()).toHaveLength(1);
  });

  it('an Ashby outage defers, then the tag lands when it is due and Ashby is back', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    w.tenant.failStatus = 503;
    await w.drain();
    expect(w.db.tagOps()[0]).toMatchObject({ state: 'pending', errorCode: 'ashby_tag_transient' });
    w.tenant.failStatus = null;
    await w.drain();
    expect(w.db.tagOps()[0].state).toBe('pending'); // not due yet
    w.db.clock += 300_000;
    await w.drain();
    expect(w.db.tagOps()[0]).toMatchObject({ state: 'succeeded', anchor: 'christy_tag_select' });
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.select]);
  });

  it('a key without tag permission waits an hour at a time, then fails after seven days', async () => {
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    w.tenant.denyList = true;
    await w.drain();
    expect(w.db.tagOps()[0]).toMatchObject({ state: 'pending', errorCode: 'ashby_tag_permission_denied' });
    w.db.clock += TAG_DEFER_AGE_LIMIT_MS + 3_600_000;
    await w.drain();
    expect(w.db.tagOps()[0]).toMatchObject({ state: 'failed', errorCode: 'ashby_tag_permission_denied' });
    expect(w.tenant.writes).toEqual([]);
  });
});

describe('the kill switch', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('off: nothing is enqueued, the lane does not run, Ashby is untouched', async () => {
    vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', 'false');
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    const outcome = await w.complete('link-1', 'session-1', 'advance');
    expect(outcome.status).toBe('parked');
    await w.drain();
    expect(w.db.tagOps()).toEqual([]);
    expect(w.tenant.writes).toEqual([]);
  });

  it('off with work pending: the operation waits, and turning it on resumes it', async () => {
    vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', 'true');
    const w = world();
    w.db.addLink('link-1', 'app-1', CAND);
    await w.complete('link-1', 'session-1', 'advance');
    expect(w.db.tagOps()).toHaveLength(1);

    vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', 'false');
    await w.drain();
    expect(w.db.tagOps()[0].state).toBe('pending');
    expect(w.tenant.writes).toEqual([]);

    vi.stubEnv('ASHBY_RECOMMENDATION_TAGS_ENABLED', 'true');
    await w.drain();
    expect(w.db.tagOps()[0]).toMatchObject({ state: 'succeeded', anchor: 'christy_tag_select' });
    expect(w.tenant.christyTitlesOn(CAND)).toEqual([TITLES.select]);
  });

  it('the real runtime wires the lane behind the switch and reports its claim', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.resolve(here, '../integrations/ashby/runtime-workers.ts'), 'utf8');
    expect(source).toMatch(/\.\.\.\(recommendationTagsEnabled\(\)\s+\? \{ recommendationTag: \{ client: runtime\.client, resolver: christyTagResolver \} \}\s+: \{\}\),/);
    expect(source).toContain('r.invite.claimed || r.scorecard.claimed || r.recommendationTag.claimed');
  });
});
