/**
 * The parse deferral at the WORKER layer: the requeue, the attempt refund, the
 * wall-clock bound, and every way the wait is refused.
 *
 * A deferral is a WEAKENING of a terminal bound. The lesson from PR #65 is
 * that a weakening whose mitigation ships separately is a weakening that ships
 * alone, so the bound is asserted here beside the behaviour it bounds — the
 * two cannot be separated without this file going red.
 */

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner } from '../lib/queue/runner.js';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
  ingestionDedupKey,
  PARSE_DEFER_DEADLINE_REASON,
  PARSE_DEFER_EXHAUSTED_REASON,
  PARSE_DEFER_UNAVAILABLE_REASON,
  DEFAULT_PARSE_DEFER_SECONDS,
  DEFAULT_PARSE_DEFER_DEADLINE_MS,
} from '../integrations/ashby/runtime-workers.js';
import { PARSE_CLASSIFIER } from '../integrations/ashby/resume-ingestion.js';
import { ParserTimeoutError, ParserOverloadError, ParserError } from '../lib/resume-parser.js';
import type { WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

async function until(pred: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await Promise.resolve();
}

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: 'handle_1', jobMappingId: 'map_1',
    candidateId: 'cand_shell_1', sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

interface World {
  link: WorkflowLinkRow;
  ingestion: { state: string; attempts: number };
  transitions: Array<{ state: string; reason?: string }>;
  defers: Array<{ linkId: string; reason: string }>;
  deferResult: { status: string; attempts?: number };
  bytes: Buffer;
  fetches: number;
  omitDeferSeam?: boolean;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    link: baseLink(),
    ingestion: { state: 'queued', attempts: 0 },
    transitions: [],
    defers: [],
    deferResult: { status: 'ok', attempts: 1 },
    bytes: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    fetches: 0,
    ...over,
  };
}

function runtimeFor(world: World, thrown: unknown) {
  const stores: Record<string, unknown> = {
    readLink: async () => world.link,
    readIngestion: async () => world.ingestion,
    advanceIngestion: async (_id: string, state: string, prov?: { failedReason?: string }) => {
      world.transitions.push({ state, reason: prov?.failedReason });
      world.ingestion = { ...world.ingestion, state };
      return { status: 'ok' };
    },
  };
  if (!world.omitDeferSeam) {
    stores.deferIngestionParse = async (linkId: string, reason: string) => {
      world.defers.push({ linkId, reason });
      if (world.deferResult.status === 'ok') {
        world.ingestion = { state: 'queued', attempts: world.ingestion.attempts + 1 };
      }
      return world.deferResult;
    };
  }
  return {
    runtimeConfig: {},
    stores,
    resolveMappingForLink: async () => null,
    materialization: {} as MaterializationStore,
    buildIngestionPorts: async (input: { onState: (s: string, p?: unknown) => Promise<void> }) => ({
      status: 'ok' as const,
      ports: {
        presignedUrl: 'https://host.example/r.pdf',
        policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
        fetch: async () => {
          world.fetches += 1;
          return {
            ok: true as const, bytes: world.bytes, sha256: 'a'.repeat(64),
            contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
          };
        },
        scan: async () => ({ safe: true, status: 'clean' }),
        guard: () => ({ ok: true as const, mime: 'application/pdf' }),
        parse: async () => { throw thrown; },
        fallbackFromText: () => ({
          name: null, email: null, phone: null, skills: [],
          experience_years: null, current_role: null, summary: null,
        }),
        onState: input.onState,
        extractorVersion: 'x1',
        classifyParse: PARSE_CLASSIFIER,
      },
    }),
  } as never;
}

const NOW = Date.now();
const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1', name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_1' },
  attempts: 1, maxAttempts: 5, createdAt: new Date(NOW).toISOString(), ...over,
}) as never;

describe('parse deferral — the happy wait', () => {
  it('a parse timeout defers instead of writing failed_review', async () => {
    const world = newWorld();
    const r = await buildAshbyHandlers(runtimeFor(world, new ParserTimeoutError()), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(r).toEqual({
      outcome: 'defer', reasonCode: 'parse_timeout', delaySeconds: DEFAULT_PARSE_DEFER_SECONDS,
    });
    expect(world.defers).toEqual([{ linkId: 'link_1', reason: 'parse_timeout' }]);
    // NOTHING was written off. The durable row went forward to `extracting`
    // and then back to `queued` through the guarded seam.
    // Two `fetching` entries: the worker leaves `queued` before touching the
    // provider, and the ingestion emits its own on entry. Both pre-date this
    // change and are unrelated to the deferral.
    expect(world.transitions.map((t) => t.state))
      .toEqual(['fetching', 'fetching', 'scanning', 'extracting']);
    expect(world.transitions.some((t) => t.state === 'failed_review')).toBe(false);
    expect(world.ingestion.state).toBe('queued');
  });

  it('a pool overload defers the same way', async () => {
    const world = newWorld();
    const r = await buildAshbyHandlers(runtimeFor(world, new ParserOverloadError()), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(r).toMatchObject({ outcome: 'defer', reasonCode: 'parse_overload' });
    expect(world.defers[0]!.reason).toBe('parse_overload');
  });

  it('the deferral wipes the resume bytes', async () => {
    const world = newWorld();
    await buildAshbyHandlers(runtimeFor(world, new ParserTimeoutError()), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(world.bytes.every((b) => b === 0)).toBe(true);
  });

  it('the queue REFUNDS the attempt a defer costs — a wait is not a failure', async () => {
    const clock = (): string => new Date(NOW).toISOString();
    const queue = new Queue(new MemoryAdapter({ clock }), { clock });
    const enqueued = await queue.enqueue(
      ASHBY_INGESTION_QUEUE, { provider: 'ashby', applicationLinkId: 'link_1' },
      { dedupKey: ingestionDedupKey('link_1'), maxAttempts: 5 },
    );
    const world = newWorld();
    const runner = createQueueRunner({
      queue,
      handlers: buildAshbyHandlers(runtimeFor(world, new ParserTimeoutError()), { nowMs: () => NOW }),
      owner: 'w1', leaseSeconds: 30, pollMs: 10,
    });
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();

    const row = await queue.getById(enqueued.id);
    expect(row!.status).toBe('delayed');
    expect(row!.attempts).toBe(0);                 // refunded
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });
});

describe('parse deferral — the bound', () => {
  it('past the WALL-CLOCK deadline the wait becomes a loud, sanitized failure', async () => {
    const world = newWorld();
    const past = NOW - (DEFAULT_PARSE_DEFER_DEADLINE_MS + 60_000);
    const r = await buildAshbyHandlers(runtimeFor(world, new ParserTimeoutError()), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job({ createdAt: new Date(past).toISOString() }));
    expect(r).toBeUndefined();                     // no defer directive
    expect(world.defers).toEqual([]);              // and no requeue
    expect(world.transitions.at(-1)).toEqual({
      state: 'failed_review', reason: PARSE_DEFER_DEADLINE_REASON,
    });
  });

  it('the deadline is derived from the JOB, so a fresh enqueue resets it — no latch', async () => {
    const world = newWorld();
    const handlers = buildAshbyHandlers(runtimeFor(world, new ParserTimeoutError()), { nowMs: () => NOW });
    // An old job is past the bound...
    await handlers[ASHBY_INGESTION_QUEUE]!(
      job({ createdAt: new Date(NOW - DEFAULT_PARSE_DEFER_DEADLINE_MS - 1).toISOString() }));
    expect(world.transitions.at(-1)?.reason).toBe(PARSE_DEFER_DEADLINE_REASON);

    // ...and a NEW job for the same link is not. There is no counter anywhere
    // that had to be reset for this to be true.
    const fresh = newWorld();
    const r = await buildAshbyHandlers(runtimeFor(fresh, new ParserTimeoutError()), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job({ createdAt: new Date(NOW).toISOString() }));
    expect(r).toMatchObject({ outcome: 'defer' });
  });

  it('an EXHAUSTED requeue ceiling rests loudly rather than deferring forever', async () => {
    const world = newWorld({ deferResult: { status: 'retry_exhausted', attempts: 5 } });
    const r = await buildAshbyHandlers(runtimeFor(world, new ParserOverloadError()), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(r).toBeUndefined();
    expect(world.transitions.at(-1)).toEqual({
      state: 'failed_review', reason: PARSE_DEFER_EXHAUSTED_REASON,
    });
  });

  it('a refused requeue for any other reason records the ORIGINAL parse code', async () => {
    const world = newWorld({ deferResult: { status: 'blocked_terminal' } });
    await buildAshbyHandlers(runtimeFor(world, new ParserTimeoutError()), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(world.transitions.at(-1)).toEqual({ state: 'failed_review', reason: 'parse_timeout' });
  });

  it('a runtime with NO defer seam fails loudly rather than waiting on something it cannot record', async () => {
    const world = newWorld({ omitDeferSeam: true });
    const r = await buildAshbyHandlers(runtimeFor(world, new ParserTimeoutError()), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(r).toBeUndefined();
    expect(world.transitions.at(-1)).toEqual({
      state: 'failed_review', reason: PARSE_DEFER_UNAVAILABLE_REASON,
    });
  });
});

describe('parse VERDICTS are unaffected by the deferral', () => {
  it('a document verdict still rests immediately, with its specific code', async () => {
    const world = newWorld();
    const r = await buildAshbyHandlers(runtimeFor(world, new ParserError('extract_failed')), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(r).toBeUndefined();
    expect(world.defers).toEqual([]);
    expect(world.transitions.at(-1)).toEqual({
      state: 'failed_review', reason: 'parse_extract_failed',
    });
  });

  it('an unknown failure still rests as exactly `parse_error`', async () => {
    const world = newWorld();
    await buildAshbyHandlers(runtimeFor(world, new Error('novel')), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(world.transitions.at(-1)).toEqual({ state: 'failed_review', reason: 'parse_error' });
  });

  it('every durable reason this path can write is bounded and DB-valid', async () => {
    const seen: string[] = [];
    for (const [thrown, deferResult] of [
      [new ParserError('bad_output'), { status: 'ok' }],
      [new ParserError('spawn_error'), { status: 'ok' }],
      [new ParserOverloadError(), { status: 'retry_exhausted' }],
      [new ParserTimeoutError(), { status: 'blocked_terminal' }],
    ] as Array<[unknown, { status: string }]>) {
      const world = newWorld({ deferResult });
      await buildAshbyHandlers(runtimeFor(world, thrown), { nowMs: () => NOW })
        [ASHBY_INGESTION_QUEUE]!(job());
      for (const t of world.transitions) if (t.reason) seen.push(t.reason);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const reason of seen) expect(reason).toMatch(/^[a-z0-9_.:-]{1,64}$/);
  });
});

describe('the ready path after a shell exists', () => {
  it('RE-READS the link binding so a shell bound mid-ingestion is never duplicated', async () => {
    // `link` is captured at the top of the handler; the import that binds the
    // shell can land during the download/scan/parse window. A stale null here
    // would create a SECOND candidate for one application.
    const world = newWorld({ link: baseLink({ candidateId: null }) });
    const materialize = vi.fn(async () => ({ id: 'resume_1' }));
    const populated: string[] = [];
    let reads = 0;
    const runtime = runtimeFor(world, new ParserTimeoutError());
    (runtime as { stores: Record<string, unknown> }).stores.readLink = async () => {
      reads += 1;
      // First read (handler entry): not yet bound. Later reads: bound.
      return reads <= 2 ? baseLink({ candidateId: null }) : baseLink({ candidateId: 'cand_shell_1' });
    };
    (runtime as { resolveMappingForLink: unknown }).resolveMappingForLink = async () => ({
      id: 'map_1', roleId: 'role_1', ownerId: 'owner_1', deliveryMode: 'manual' as const,
    });
    (runtime as { materialization: MaterializationStore }).materialization = {
      insertResume: materialize,
      insertCandidate: async () => { throw new Error('must_not_create_a_second_candidate'); },
      insertCandidateShell: async () => ({ id: 'unused' }),
      updateCandidateFromParse: async (i) => { populated.push(i.candidateId); return { updated: true }; },
      bindLinkColumn: async (i) => ({ bound: i.value, wonRace: true }),
      deleteOrphan: async () => {},
      createSession: async () => ({ id: 's' }),
      findActiveInvite: async () => null,
      insertInvite: async () => ({ id: 'i' }),
    };
    // Make the parse SUCCEED for this one case.
    (runtime as { buildIngestionPorts: unknown }).buildIngestionPorts =
      async (input: { onState: (s: string, p?: unknown) => Promise<void> }) => ({
        status: 'ok' as const,
        ports: {
          presignedUrl: 'https://host.example/r.pdf',
          policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
          fetch: async () => ({
            ok: true as const, bytes: Buffer.from('x'), sha256: 'a'.repeat(64),
            contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
          }),
          scan: async () => ({ safe: true, status: 'clean' }),
          guard: () => ({ ok: true as const, mime: 'application/pdf' }),
          parse: async () => ({
            text: 'Ada', structurerVersion: 'v1',
            structured: {
              name: 'Ada', email: 'ada@example.com', phone: null, skills: [],
              experience_years: null, current_role: null, summary: null,
            },
          }),
          fallbackFromText: () => ({
            name: null, email: null, phone: null, skills: [],
            experience_years: null, current_role: null, summary: null,
          }),
          onState: input.onState,
          extractorVersion: 'x1',
          classifyParse: PARSE_CLASSIFIER,
        },
      });

    await buildAshbyHandlers(runtime, { nowMs: () => NOW })[ASHBY_INGESTION_QUEUE]!(job());
    expect(populated).toEqual(['cand_shell_1']);
  });
});
