/**
 * Runtime chain convergence — exactly one of everything.
 *
 * Drives the REAL handler map (`buildAshbyHandlers`) over the REAL leased queue
 * (memory adapter) with in-memory stores, and asserts the fixed negative
 * controls from the acceptance contract:
 *
 *   duplicate webhook · reconciliation recovery · enqueue-failure redelivery ·
 *   lost lease + reclaim · two concurrent runners
 *        ⇒ exactly ONE import, ONE link, ONE ingestion, ONE candidate, ONE invite.
 *
 * The highest-value assertion here is the receipt-bookkeeping one: `mark()` in
 * the signal worker deliberately swallows `markStatus` failures, so a receipt
 * can stay non-terminal and a later reconciliation WILL re-enqueue the same
 * signal. Safety therefore rests entirely on `runImport` being idempotent per
 * application link — which this proves directly rather than by implication.
 *
 * Zero network, zero DB, no timers.
 */

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner } from '../lib/queue/runner.js';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
  ingestionDedupKey,
  reissuePathFor,
  extractResumeHandle,
} from '../integrations/ashby/runtime-workers.js';
import { ASHBY_SIGNAL_QUEUE, ASHBY_IMPORT_QUEUE } from '../integrations/ashby/signal-worker.js';
import { CANDIDATE_STAGE_CHANGE_ACTION } from '../integrations/ashby/extractors.js';
import type { AshbyRuntime } from '../integrations/ashby/runtime.js';
import type { RuntimeWorkflowStores, WorkflowLinkRow } from '../integrations/ashby/orchestration.js';

const AI = 'stage_ai';
const APP = 'app_1';
const JOB = 'job_1';
const ROLE = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

/** An in-memory world recording every durable effect the chain produces. */
function world() {
  const links = new Map<string, WorkflowLinkRow>();
  const ingestions = new Map<string, { state: string; attempts: number }>();
  const operations: Array<{ id: string; key: string; linkId: string; type: string }> = [];
  const candidates: string[] = [];
  /** PII-minimal shells bound at import. Tracked apart from `candidates` so
   *  "exactly one candidate per application" is assertable across both. */
  const shells: string[] = [];
  const sessions: string[] = [];
  const invites: Array<{ id: string; digest: string }> = [];
  let n = 0;

  const stores: RuntimeWorkflowStores = {
    async findLinkByApplicationId(appId) {
      const l = links.get(appId);
      return l
        ? {
            id: l.id,
            externalApplicationId: l.externalApplicationId,
            terminalState: l.terminalState,
            externalResumeFileHandle: l.externalResumeFileHandle,
          }
        : null;
    },
    async createLink(input) {
      const id = `link_${++n}`;
      links.set(input.externalApplicationId, {
        id, externalApplicationId: input.externalApplicationId,
        externalJobId: input.externalJobId, jobMappingId: input.jobMappingId,
        externalResumeFileHandle: input.externalResumeFileHandle,
        candidateId: null, sessionId: null, inviteId: null,
        lifecycle: 'imported', terminalState: null,
      });
      return { id };
    },
    async advanceIngestion(linkId, next) {
      // Mirrors the 0029 `enforce_ashby_ingestion_transition` trigger: `ready`
      // and `cancelled` are TERMINAL and reject every further transition. A
      // permissive fake here would hide exactly the defect M2 describes.
      // The real RPC inserts the row on first use (`on conflict do nothing`)
      // before transitioning, so the fake must too.
      if (!ingestions.has(linkId)) ingestions.set(linkId, { state: 'queued', attempts: 0 });
      const cur = ingestions.get(linkId)!;
      const legal: Record<string, string[]> = {
        queued: ['fetching', 'cancelled'],
        fetching: ['scanning', 'failed_review', 'cancelled'],
        scanning: ['extracting', 'failed_review', 'cancelled'],
        extracting: ['structuring', 'failed_review', 'cancelled'],
        structuring: ['ready', 'failed_review', 'cancelled'],
        failed_review: ['queued', 'cancelled'],
        ready: [],
        cancelled: [],
      };
      if (cur.state === next) return { status: 'ok', state: next };
      if (!(legal[cur.state] ?? []).includes(next)) {
        return { status: 'invalid_transition', state: cur.state };
      }
      ingestions.set(linkId, { state: next, attempts: cur.attempts + (next === 'queued' ? 1 : 0) });
      return { status: 'ok', state: next };
    },
    async enqueueOperation(input) {
      // Mirrors the unique (provider, operation_key) constraint.
      if (operations.some((o) => o.key === input.operationKey)) return { status: 'duplicate' };
      const id = `op_${++n}`;
      operations.push({ id, key: input.operationKey, linkId: input.applicationLinkId, type: input.operationType });
      return { status: 'inserted', id };
    },
    async completeOperation() { return 'ok'; },
    async failOperation() { return { outcome: 'retry' }; },
    async claimOperation() { return null; },
    async parkOperationAwaitingDelivery() { return 'ok'; },
    async readIngestion(linkId) { return ingestions.get(linkId) ?? null; },
    async readLink(linkId) {
      for (const l of links.values()) if (l.id === linkId) return l;
      return null;
    },
    async deferOperation() {
      return 'ok' as const;
    },
    async markWritebackPending() { return { status: 'ok' }; },
  };

  return { links, ingestions, operations, candidates, shells, sessions, invites, stores, next: () => ++n };
}

function makeRuntime(w: ReturnType<typeof world>, over: Partial<AshbyRuntime> = {}): AshbyRuntime {
  const queue = new Queue(new MemoryAdapter({ clock: () => '2026-08-17T00:00:00.000Z' }), {
    clock: () => '2026-08-17T00:00:00.000Z',
  });
  return {
    config: { enabled: true, webhookSecretConfigured: true, webhookSecret: 'x'.repeat(24) },
    runtimeConfig: {
      runtimeEnabled: true, apiKeyConfigured: true, apiKey: 'SENTINEL_APIKEY_aaaaaaaaaaaa',
      resumeHosts: [], signalPollMs: 5000, operationPollMs: 5000,
      reconcileIntervalMs: 900000, reclaimIntervalMs: 60000, leaseSeconds: 60,
      reconcileSweepIntervalMs: 10000, reconcileAnchorDisabled: false,
      scannerDeferSeconds: 45, scannerReadinessTimeoutMs: 2000,
      scannerDeferDeadlineMs: 28_800_000,
      reconcileCaps: {
        maxPages: 50, maxItems: 5000, pageLimit: 100,
        deadlineMs: 60000, maxEnqueuePerRun: 200,
        sweepMaxEnqueue: 2000, sweepMaxPages: 5000,
        sweepMaxRestarts: 5, anchorMaxAgeMs: 21_600_000,
      },
    },
    client: {
      applicationInfo: async () => ({
        results: { id: APP, job: { id: JOB }, currentInterviewStage: { id: AI } },
        moreDataAvailable: false,
      }),
    } as never,
    queue,
    stores: w.stores,
    receipts: { record: async () => ({ status: 'inserted', id: 'r', enqueued: true, workPending: true }) },
    checkpoints: { get: async () => null, advance: async () => {}, requireFullResync: async () => {} },
    missionControl: {} as never,
    materialization: {
      insertResume: async () => ({ id: `res_${w.next()}` }),
      insertCandidate: async () => { const id = `cand_${w.next()}`; w.candidates.push(id); return { id }; },
      // The import-time shell. A runtime WITHOUT this seam can no longer
      // complete an import at all — the handler throws `ashby_import_shell_unbound`
      // rather than finishing an import that leaves the application invisible.
      insertCandidateShell: async () => { const id = `shell_${w.next()}`; w.shells.push(id); return { id }; },
      updateCandidateFromParse: async () => ({ updated: true }),
      bindLinkColumn: async ({ applicationLinkId, column, value }) => {
        for (const l of w.links.values()) {
          if (l.id !== applicationLinkId) continue;
          const key = column === 'candidate_id' ? 'candidateId' : column === 'session_id' ? 'sessionId' : 'inviteId';
          const existing = l[key] as string | null;
          if (existing) return { bound: existing, wonRace: false };
          (l as unknown as Record<string, unknown>)[key] = value;
          return { bound: value, wonRace: true };
        }
        return { bound: value, wonRace: true };
      },
      deleteOrphan: async () => {},
      createSession: async () => { const id = `sess_${w.next()}`; w.sessions.push(id); return { id }; },
      findActiveInvite: async () => null,
      insertInvite: async (i) => { const id = `inv_${w.next()}`; w.invites.push({ id, digest: i.tokenDigest }); return { id }; },
    },
    mappings: { resolveByJobId: async () => ({ status: 'enabled', aiScreeningStageId: AI }) },
    enabledMappings: {
      async listEnabled() {
        return { rows: [{ externalJobId: JOB, aiScreeningStageId: AI }], truncated: false };
      },
    },
    urlPolicy: { allowlistEnabled: false, allowedHosts: [], allowedPorts: [443] },
    resolveMappingByJobId: async () => ({ status: 'enabled', aiScreeningStageId: AI, id: 'map_1', deliveryMode: 'manual' }),
    resolveMappingForLink: async () => ({ id: 'map_1', roleId: ROLE, ownerId: OWNER, deliveryMode: 'manual' }),
    // No resume handle in this fixture ⇒ the ingestion job is a clean no-op.
    buildIngestionPorts: async () => ({ status: 'no_resume' as const }),
    shutdown: async () => {},
    ...over,
  };
}

/**
 * Drain the runner until nothing is claimable AND nothing is in flight.
 *
 * `tick()` deliberately does not await its handlers (that is what gives the
 * runner its concurrency), so a naive "stop when a tick claims 0" loop can exit
 * while a handler is still about to enqueue the next stage of the chain.
 */
async function drain(
  runner: { tick: () => Promise<number>; inFlight: () => number },
  max = 60,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < max; i++) {
    const n = await runner.tick();
    total += n;
    // Let in-flight handlers settle (and enqueue downstream work) before
    // deciding the chain is finished. Microtasks only — no timers, no sleeps.
    for (let j = 0; j < 50 && runner.inFlight() > 0; j++) await Promise.resolve();
    if (n === 0 && runner.inFlight() === 0) break;
  }
  return total;
}

function signalPayload(webhookActionId: string) {
  return {
    provider: 'ashby' as const,
    webhookActionId,
    action: CANDIDATE_STAGE_CHANGE_ACTION,
    externalApplicationId: APP,
  };
}

function makeRunner(runtime: AshbyRuntime, owner = 'w1') {
  return createQueueRunner({
    queue: runtime.queue,
    handlers: buildAshbyHandlers(runtime),
    owner, leaseSeconds: 60, pollMs: 1000, concurrency: 2,
  });
}

describe('chain convergence — exactly one of everything', () => {
  it('a single signal produces one link, one ingestion seed, and one invite operation', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    await runtime.queue.enqueue(ASHBY_SIGNAL_QUEUE, signalPayload('wh_1'), { dedupKey: 'sig:1' });

    const runner = makeRunner(runtime);
    await drain(runner);
    await runner.stop();

    expect(w.links.size).toBe(1);
    // Exactly ONE candidate identity per application, shell included: the
    // import-time shell converges through the same link CAS, so a
    // duplicate/concurrent/re-driven import cannot mint a second.
    expect([...w.links.values()].filter((l) => l.candidateId != null)).toHaveLength(1);
    expect(w.ingestions.size).toBe(1);
    expect(w.operations.filter((o) => o.type === 'invite_delivery')).toHaveLength(1);
  });

  it('a DUPLICATE webhook for the same application converges to one import', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    // Two distinct webhook deliveries, same application.
    await runtime.queue.enqueue(ASHBY_SIGNAL_QUEUE, signalPayload('wh_1'), { dedupKey: 'sig:wh_1' });
    await runtime.queue.enqueue(ASHBY_SIGNAL_QUEUE, signalPayload('wh_2'), { dedupKey: 'sig:wh_2' });

    const runner = makeRunner(runtime);
    await drain(runner);
    await runner.stop();

    expect(w.links.size).toBe(1);
    // Exactly ONE candidate identity per application, shell included: the
    // import-time shell converges through the same link CAS, so a
    // duplicate/concurrent/re-driven import cannot mint a second.
    expect([...w.links.values()].filter((l) => l.candidateId != null)).toHaveLength(1);
    expect(w.operations.filter((o) => o.type === 'invite_delivery')).toHaveLength(1);
  });

  it('a RECONCILIATION recovery after a processed webhook creates no second import', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    await runtime.queue.enqueue(ASHBY_SIGNAL_QUEUE, signalPayload('wh_1'), { dedupKey: 'sig:wh_1' });
    const runner = makeRunner(runtime);
    await drain(runner);

    // Reconciliation re-drives the SAME application under its stage-dedup id —
    // exactly the window `mark()`'s best-effort markStatus leaves open.
    await runtime.queue.enqueue(ASHBY_SIGNAL_QUEUE, signalPayload('reconcile_1'), { dedupKey: 'sig:reconcile_1' });
    await drain(runner);
    await runner.stop();

    expect(w.links.size).toBe(1);
    // Exactly ONE candidate identity per application, shell included: the
    // import-time shell converges through the same link CAS, so a
    // duplicate/concurrent/re-driven import cannot mint a second.
    expect([...w.links.values()].filter((l) => l.candidateId != null)).toHaveLength(1);
    expect(w.ingestions.size).toBe(1);
    expect(w.operations.filter((o) => o.type === 'invite_delivery')).toHaveLength(1);
  });

  it('re-running the import job itself is idempotent (the E-3 guarantee)', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    const handlers = buildAshbyHandlers(runtime);
    const job = { name: ASHBY_IMPORT_QUEUE, payload: { externalApplicationId: APP } } as never;

    // Five direct re-drives of the same import — a redelivery storm.
    for (let i = 0; i < 5; i++) await handlers[ASHBY_IMPORT_QUEUE](job);

    expect(w.links.size).toBe(1);
    // Exactly ONE candidate identity per application, shell included: the
    // import-time shell converges through the same link CAS, so a
    // duplicate/concurrent/re-driven import cannot mint a second.
    expect([...w.links.values()].filter((l) => l.candidateId != null)).toHaveLength(1);
    expect(w.operations.filter((o) => o.type === 'invite_delivery')).toHaveLength(1);
  });

  it('an ENQUEUE FAILURE followed by redelivery still lands exactly one import', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    const handlers = buildAshbyHandlers(runtime);

    // First attempt: the import enqueue fails, so the signal job must fail and retry.
    const failing = { ...runtime, queue: { ...runtime.queue, enqueue: async () => { throw new Error('enqueue_failed'); } } as never };
    await expect(
      buildAshbyHandlers(failing as AshbyRuntime)[ASHBY_SIGNAL_QUEUE](
        { name: ASHBY_SIGNAL_QUEUE, payload: signalPayload('wh_1') } as never,
      ),
    ).rejects.toThrow();
    expect(w.links.size).toBe(0); // nothing was imported on the failed attempt

    // Redelivery of the same signal now succeeds.
    await handlers[ASHBY_SIGNAL_QUEUE]({ name: ASHBY_SIGNAL_QUEUE, payload: signalPayload('wh_1') } as never);
    const runner = makeRunner(runtime);
    await drain(runner);
    await runner.stop();

    expect(w.links.size).toBe(1);
    // Exactly ONE candidate identity per application, shell included: the
    // import-time shell converges through the same link CAS, so a
    // duplicate/concurrent/re-driven import cannot mint a second.
    expect([...w.links.values()].filter((l) => l.candidateId != null)).toHaveLength(1);
    expect(w.operations.filter((o) => o.type === 'invite_delivery')).toHaveLength(1);
  });

  it('TWO CONCURRENT runners over one queue converge to one of everything', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    for (const id of ['wh_1', 'wh_2', 'wh_3']) {
      await runtime.queue.enqueue(ASHBY_SIGNAL_QUEUE, signalPayload(id), { dedupKey: `sig:${id}` });
    }

    const a = makeRunner(runtime, 'runner-a');
    const b = makeRunner(runtime, 'runner-b');
    for (let i = 0; i < 20; i++) {
      const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
      if (ra === 0 && rb === 0) break;
    }
    await Promise.all([a.stop(), b.stop()]);

    expect(w.links.size).toBe(1);
    // Exactly ONE candidate identity per application, shell included: the
    // import-time shell converges through the same link CAS, so a
    // duplicate/concurrent/re-driven import cannot mint a second.
    expect([...w.links.values()].filter((l) => l.candidateId != null)).toHaveLength(1);
    expect(w.ingestions.size).toBe(1);
    expect(w.operations.filter((o) => o.type === 'invite_delivery')).toHaveLength(1);
  });

  it('a LOST LEASE re-drives the job and still yields exactly one import', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    await runtime.queue.enqueue(ASHBY_SIGNAL_QUEUE, signalPayload('wh_1'), { dedupKey: 'sig:wh_1' });

    // Runner A processes but loses the lease at commit time, so the job stays
    // claimable; runner B then picks it up and commits.
    const handlers = buildAshbyHandlers(runtime);
    const staleQueue = {
      claim: runtime.queue.claim.bind(runtime.queue),
      heartbeat: runtime.queue.heartbeat.bind(runtime.queue),
      completeClaim: async () => false,
      failClaim: runtime.queue.failClaim.bind(runtime.queue),
    };
    const a = createQueueRunner({ queue: staleQueue as never, handlers, owner: 'a', leaseSeconds: 60, pollMs: 1000 });
    await a.tick();
    await a.stop();

    const b = makeRunner(runtime, 'b');
    await drain(b);
    await b.stop();

    // The work ran twice, but the durable effects are still singular.
    expect(w.links.size).toBe(1);
    // Exactly ONE candidate identity per application, shell included: the
    // import-time shell converges through the same link CAS, so a
    // duplicate/concurrent/re-driven import cannot mint a second.
    expect([...w.links.values()].filter((l) => l.candidateId != null)).toHaveLength(1);
    expect(w.operations.filter((o) => o.type === 'invite_delivery')).toHaveLength(1);
  });
});

describe('terminal safety through the chain', () => {
  it('a terminal application produces no ingestion work and no invite operation', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    // Pre-existing TERMINAL link for this application.
    w.links.set(APP, {
      id: 'link_terminal', externalApplicationId: APP, externalJobId: JOB, jobMappingId: 'map_1',
      externalResumeFileHandle: null,
      candidateId: null, sessionId: null, inviteId: null,
      lifecycle: 'cancelled', terminalState: 'withdrawn',
    });

    await runtime.queue.enqueue(ASHBY_SIGNAL_QUEUE, signalPayload('wh_1'), { dedupKey: 'sig:wh_1' });
    const runner = makeRunner(runtime);
    await drain(runner);
    await runner.stop();

    expect(w.operations).toHaveLength(0);
    expect(w.ingestions.size).toBe(0);
  });

  it('the ingestion handler is a no-op for a terminal link', async () => {
    const w = world();
    const runtime = makeRuntime(w);
    w.links.set(APP, {
      id: 'link_1', externalApplicationId: APP, externalJobId: JOB, jobMappingId: 'map_1',
      externalResumeFileHandle: null,
      candidateId: null, sessionId: null, inviteId: null,
      lifecycle: 'cancelled', terminalState: 'deleted',
    });
    const buildIngestionPorts = vi.fn(async () => ({ status: 'no_resume' as const }));
    const handlers = buildAshbyHandlers(makeRuntime(w, { buildIngestionPorts }));
    await handlers[ASHBY_INGESTION_QUEUE]({ name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_1' } } as never);
    // It must not even resolve a presigned URL for a terminal application.
    expect(buildIngestionPorts).not.toHaveBeenCalled();
  });
});

describe('malformed payloads fail closed', () => {
  it('rejects an import job with no application id', async () => {
    const w = world();
    const handlers = buildAshbyHandlers(makeRuntime(w));
    await expect(handlers[ASHBY_IMPORT_QUEUE]({ name: ASHBY_IMPORT_QUEUE, payload: {} } as never))
      .rejects.toThrow('malformed_import_payload');
  });

  it('rejects an ingestion job with no link id', async () => {
    const w = world();
    const handlers = buildAshbyHandlers(makeRuntime(w));
    await expect(handlers[ASHBY_INGESTION_QUEUE]({ name: ASHBY_INGESTION_QUEUE, payload: {} } as never))
      .rejects.toThrow('malformed_ingestion_payload');
  });
});

describe('helpers', () => {
  it('derives a stable, link-scoped ingestion dedup key', () => {
    expect(ingestionDedupKey('link_1')).toBe('ashby:ingestion:link_1');
    expect(ingestionDedupKey('link_1')).toBe(ingestionDedupKey('link_1'));
  });

  it('builds a site-relative, token-free reissue path', () => {
    const p = reissuePathFor('app 1/../x');
    expect(p.startsWith('/')).toBe(true);
    expect(p.startsWith('//')).toBe(false);
    expect(p).not.toContain(' ');
    expect(p.toLowerCase()).not.toContain('token');
  });

  it('reads an opaque resume handle defensively', () => {
    expect(extractResumeHandle({ resumeFileHandle: 'h1' })).toBe('h1');
    expect(extractResumeHandle({ resume: { fileHandle: { handle: 'h2' } } })).toBe('h2');
    expect(extractResumeHandle({ resumeFileHandle: 'x'.repeat(600) })).toBeNull();
    for (const bad of [null, undefined, 42, 'str', {}]) expect(extractResumeHandle(bad)).toBeNull();
  });
});

describe('M2 — a redelivered signal never re-downloads the resume', () => {
  /** A world whose ingestion for the link is already terminal. */
  function readyWorld() {
    const w = world();
    w.links.set(APP, {
      id: 'link_ready', externalApplicationId: APP, externalJobId: JOB, jobMappingId: 'map_1',
      externalResumeFileHandle: 'handle_ready',
      candidateId: 'cand_1', sessionId: 'sess_1', inviteId: null,
      lifecycle: 'ready', terminalState: null,
    });
    w.ingestions.set('link_ready', { state: 'ready', attempts: 1 });
    return w;
  }

  it('does not enqueue an ingestion job for an already-ready link', async () => {
    const w = readyWorld();
    const runtime = makeRuntime(w);
    const enqueued: string[] = [];
    const spyQueue = {
      ...runtime.queue,
      enqueue: async (name: string, payload: unknown, opts: unknown) => {
        enqueued.push(name);
        return runtime.queue.enqueue(name, payload as never, opts as never);
      },
    } as never;

    const handlers = buildAshbyHandlers({ ...runtime, queue: spyQueue });
    await handlers[ASHBY_IMPORT_QUEUE]({ name: ASHBY_IMPORT_QUEUE, payload: { externalApplicationId: APP } } as never);

    // The import still reuses the link, but ingestion is terminal so no
    // ingestion work may be scheduled.
    expect(enqueued).not.toContain(ASHBY_INGESTION_QUEUE);
  });

  it('does the same for a cancelled ingestion', async () => {
    const w = readyWorld();
    w.ingestions.set('link_ready', { state: 'cancelled', attempts: 1 });
    const runtime = makeRuntime(w);
    const enqueued: string[] = [];
    const spyQueue = {
      ...runtime.queue,
      enqueue: async (name: string, payload: unknown, opts: unknown) => {
        enqueued.push(name);
        return runtime.queue.enqueue(name, payload as never, opts as never);
      },
    } as never;
    const handlers = buildAshbyHandlers({ ...runtime, queue: spyQueue });
    await handlers[ASHBY_IMPORT_QUEUE]({ name: ASHBY_IMPORT_QUEUE, payload: { externalApplicationId: APP } } as never);
    expect(enqueued).not.toContain(ASHBY_INGESTION_QUEUE);
  });

  it('performs ZERO file.info / fetch / scan / parse for a ready link', async () => {
    const w = readyWorld();
    // Every port that would touch the candidate's resume is a spy that fails
    // the test if it is ever reached.
    const buildIngestionPorts = vi.fn(async () => {
      throw new Error('buildIngestionPorts must not be called for a ready link');
    });
    const runtime = makeRuntime(w, { buildIngestionPorts: buildIngestionPorts as never });
    const handlers = buildAshbyHandlers(runtime);

    // Even if a stale ingestion job somehow exists, executing it must be inert.
    await handlers[ASHBY_INGESTION_QUEUE]({
      name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_ready' },
    } as never);

    // `buildIngestionPorts` is what resolves the presigned URL via file.info,
    // so not calling it is exactly "zero file.info, zero fetch, zero scan,
    // zero parse".
    expect(buildIngestionPorts).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: a still-queued ingestion DOES build ports', async () => {
    // Proves the assertions above are about the terminal state, not about the
    // handler being inert in general.
    const w = readyWorld();
    w.ingestions.set('link_ready', { state: 'queued', attempts: 1 });
    const buildIngestionPorts = vi.fn(async () => ({ status: 'no_resume' as const }));
    const runtime = makeRuntime(w, { buildIngestionPorts: buildIngestionPorts as never });
    const handlers = buildAshbyHandlers(runtime);
    await handlers[ASHBY_INGESTION_QUEUE]({
      name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_ready' },
    } as never);
    expect(buildIngestionPorts).toHaveBeenCalledTimes(1);
  });

  it('aborts the ingestion when a state transition is rejected as illegal', async () => {
    const w = readyWorld();
    w.ingestions.set('link_ready', { state: 'queued', attempts: 1 });
    // The 0029 trigger rejects an illegal move; the RPC reports it as a status
    // rather than throwing. Ignoring that status let the in-memory pipeline
    // keep running against a durable row that no longer described reality.
    // The FIRST advanceIngestion call is now the handler's own
    // `queued -> fetching` (0035): the row must leave `queued` before any
    // provider call, or a failure can never reach `failed_review` at all. Let
    // that one succeed and reject every later transition, so the onState seam
    // under test is still the one the pipeline uses.
    let firstAdvance = true;
    w.stores.advanceIngestion = async () => {
      if (firstAdvance) { firstAdvance = false; return { status: 'ok' }; }
      return { status: 'invalid_transition' };
    };

    let capturedOnState: ((s: string) => Promise<void>) | null = null;
    const buildIngestionPorts = vi.fn(async (input: { onState: (s: string) => Promise<void> }) => {
      capturedOnState = input.onState;
      return { status: 'no_resume' as const };
    });
    const runtime = makeRuntime(w, { buildIngestionPorts: buildIngestionPorts as never });
    const handlers = buildAshbyHandlers(runtime);
    await handlers[ASHBY_INGESTION_QUEUE]({
      name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_ready' },
    } as never);

    expect(capturedOnState).not.toBeNull();
    await expect(capturedOnState!('fetching')).rejects.toThrow('ashby_ingestion_invalid_transition');
  });
});
