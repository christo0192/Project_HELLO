/**
 * The cold-start incident, end to end at the worker layer.
 *
 * WHAT HAPPENED: a replayed canary ingestion was claimed seconds after a
 * deploy, before freshclam had established the ClamAV database. The pipeline
 * resolved a presigned URL, downloaded the candidate's resume, handed it to a
 * scanner that had nothing to screen with, and wrote the refusal down as
 * `failed_review / scan_scanner_signatures_unavailable` with one attempt
 * spent. Nothing about the job was faulty. With no persistent database
 * directory and `auto_stop_machines`, that window recurs on every deploy,
 * autostart, crash and machine replacement.
 *
 * WHAT MUST BE TRUE NOW: while the scanner cannot screen, an ingestion job is
 * never claimed at all — so no attempt, no lease, no provider call, no resume
 * bytes — and the durable row stays exactly where it was. The moment the
 * scanner is ready, ONE claim proceeds.
 */

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner } from '../lib/queue/runner.js';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
  ingestionDedupKey,
  DEFER_DEADLINE_REASON,
  DEFER_EXHAUSTED_REASON,
} from '../integrations/ashby/runtime-workers.js';
import { checkScannerReadiness } from '../integrations/ashby/scanner-readiness.js';
import type { SignatureState } from '../lib/clamav-signatures.js';
import type { WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

const CLAMAV = { RESUME_SCANNER: 'clamav', NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const FRESH: SignatureState = { fresh: true, ageSec: 60, maxAgeSec: 86_400, reason: null };
const COLD: SignatureState = { fresh: false, ageSec: null, maxAgeSec: 86_400, reason: 'signatures_missing' };

async function until(pred: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await Promise.resolve();
}

interface World {
  link: WorkflowLinkRow;
  ingestion: { state: string; attempts: number } | null;
  transitions: Array<{ state: string; reason?: string }>;
  fileInfoCalls: number;
  fetches: number;
  advanceOverride?: (state: string) => { status: string } | null;
}

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: 'handle_1', jobMappingId: 'map_1',
    candidateId: null, sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

function newWorld(over: Partial<World> = {}): World {
  return {
    link: baseLink(),
    ingestion: { state: 'queued', attempts: 0 },
    transitions: [],
    fileInfoCalls: 0,
    fetches: 0,
    ...over,
  };
}

/**
 * A runtime whose ports factory records provider contact. `scanStatus` decides
 * what the scanner says when (and only when) bytes actually reach it.
 */
function runtimeFor(world: World, scanStatus = 'clean') {
  const buildIngestionPorts = vi.fn(async (input: { onState: (s: string, p?: unknown) => Promise<void> }) => {
    world.fileInfoCalls += 1;   // stands in for client.fileInfo + presigned URL
    return {
      status: 'ok' as const,
      ports: {
        presignedUrl: 'https://host.example/r.pdf',
        policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
        fetch: async () => {
          world.fetches += 1;
          return {
            ok: true as const, bytes: Buffer.from('resume'), sha256: 'a'.repeat(64),
            contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
          };
        },
        scan: async () => ({ safe: scanStatus === 'clean', status: scanStatus }),
        guard: () => ({ ok: true as const, mime: 'application/pdf' }),
        parse: async () => ({
          text: 'Ada', structurerVersion: 'v1',
          structured: { name: 'Ada', email: null, phone: null, skills: [], experience_years: null, current_role: null, summary: null },
        }),
        fallbackFromText: () => ({ name: null, email: null, phone: null, skills: [], experience_years: null, current_role: null, summary: null }),
        onState: input.onState,
        extractorVersion: 'x1',
        classifyScan: (s: string) =>
          (s === 'clean' || s === 'infected' ? 'verdict'
            : s.startsWith('scanner_signatures') || s === 'scanner_unavailable' ? 'availability'
              : 'transient'),
      },
    };
  });

  return {
    runtime: {
      runtimeConfig: {},
      stores: {
        readLink: async () => world.link,
        readIngestion: async () => world.ingestion,
        advanceIngestion: async (_id: string, state: string, prov?: { failedReason?: string }) => {
          const override = world.advanceOverride?.(state);
          if (override) return override;
          world.transitions.push({ state, reason: prov?.failedReason });
          world.ingestion = { state, attempts: world.ingestion?.attempts ?? 0 };
          return { status: 'ok' };
        },
      },
      buildIngestionPorts,
      resolveMappingForLink: async () => null,
      materialization: {} as MaterializationStore,
    } as never,
    buildIngestionPorts,
  };
}

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job_1', name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_1' },
  attempts: 1, maxAttempts: 5, createdAt: '2026-08-19T00:00:00.000Z', ...over,
}) as never;

// ═══════════════════════════════════════════════════════════════════════
// 1. Cold boot: the job is never claimed at all
// ═══════════════════════════════════════════════════════════════════════

describe('cold boot with a queued canary ingestion', () => {
  it('120 cold polls: zero claims, zero attempts, zero DLQ, zero provider calls, row still queued', async () => {
    const clock = (): string => '2026-08-19T00:00:00.000Z';
    const queue = new Queue(new MemoryAdapter({ clock }), { clock });
    const enqueued = await queue.enqueue(
      ASHBY_INGESTION_QUEUE, { provider: 'ashby', applicationLinkId: 'link_1' },
      { dedupKey: ingestionDedupKey('link_1'), maxAttempts: 5 },
    );
    const world = newWorld();
    const { runtime, buildIngestionPorts } = runtimeFor(world);
    const claimSpy = vi.spyOn(queue, 'claim');

    let fresh = false;
    const runner = createQueueRunner({
      queue,
      handlers: buildAshbyHandlers(runtime),
      owner: 'w1', leaseSeconds: 30, pollMs: 10,
      shouldClaim: async (name) => {
        if (name !== ASHBY_INGESTION_QUEUE) return true;
        const v = await checkScannerReadiness({
          source: CLAMAV, freshness: async () => (fresh ? FRESH : COLD),
        });
        return v.action === 'proceed';
      },
    });

    for (let i = 0; i < 120; i++) await runner.tick();
    await until(() => runner.inFlight() === 0);

    // The point is the ABSENCE of the claim on THIS queue. The runner's other
    // queues are untouched by the gate and go on polling normally.
    expect(claimSpy.mock.calls.filter(([name]) => name === ASHBY_INGESTION_QUEUE)).toEqual([]);
    expect(buildIngestionPorts).not.toHaveBeenCalled();
    expect(world.fileInfoCalls).toBe(0);
    expect(world.fetches).toBe(0);
    expect(world.transitions).toEqual([]);
    expect(world.ingestion).toMatchObject({ state: 'queued' });

    const row = await queue.getById(enqueued.id);
    expect(row!.attempts).toBe(0);
    expect(row!.status).toBe('pending');
    expect(await queue.getDlqJobs()).toHaveLength(0);

    // ── freshclam lands ──────────────────────────────────────────────────
    fresh = true;
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();

    // EXACTLY ONE ingestion runs — not 121 queued-up copies.
    expect(buildIngestionPorts).toHaveBeenCalledTimes(1);
    expect(world.ingestion).toMatchObject({ state: 'ready' });
    expect((await queue.getById(enqueued.id))!.status).toBe('completed');
    vi.restoreAllMocks();
  });

  it('the held queue does not stop other Ashby queues draining', async () => {
    const clock = (): string => '2026-08-19T00:00:00.000Z';
    const queue = new Queue(new MemoryAdapter({ clock }), { clock });
    await queue.enqueue(ASHBY_INGESTION_QUEUE, { applicationLinkId: 'link_1' });
    const other = await queue.enqueue('ashby.import', { externalApplicationId: 'app_1' });

    let ran = false;
    const runner = createQueueRunner({
      queue,
      handlers: {
        [ASHBY_INGESTION_QUEUE]: async () => { throw new Error('must_not_run'); },
        'ashby.import': async () => { ran = true; },
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 10,
      shouldClaim: (name) => name !== ASHBY_INGESTION_QUEUE,
    });
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();
    expect(ran).toBe(true);
    expect((await queue.getById(other.id))!.status).toBe('completed');
  });

  it('a restart re-derives the hold from the filesystem, not from memory', async () => {
    // Readiness is a machine-local fact with no in-process state to lose, so a
    // restarted worker reaches the same verdict on the same directory.
    const cold = await checkScannerReadiness({ source: CLAMAV, freshness: async () => COLD });
    const again = await checkScannerReadiness({ source: CLAMAV, freshness: async () => COLD });
    expect(cold).toEqual(again);
    expect(cold.action).toBe('defer');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Post-claim race: readiness lapses between the gate and the scan
// ═══════════════════════════════════════════════════════════════════════

describe('post-claim scanner race', () => {
  it('defers instead of failing when the scanner loses its database mid-flight', async () => {
    const world = newWorld();
    const { runtime } = runtimeFor(world, 'scanner_signatures_unavailable');
    const handlers = buildAshbyHandlers(runtime, { scannerGate: async () => ({ action: 'proceed', mode: 'clamav' }) });

    const result = await handlers[ASHBY_INGESTION_QUEUE](job());

    expect(result).toMatchObject({
      outcome: 'defer', reasonCode: 'scan_scanner_signatures_unavailable', delaySeconds: 300,
    });
    // The row went back to `queued` (0037 retry edge) and carries NO failure.
    // `fetching` appears twice: the handler leaves `queued` before touching the
    // provider, and the pipeline re-emits its own first state (a same-state
    // no-op in the RPC). What matters is the tail.
    expect(world.transitions.map((t) => t.state)).toEqual(['fetching', 'fetching', 'scanning', 'queued']);
    expect(world.transitions.some((t) => t.state === 'failed_review')).toBe(false);
    expect(world.ingestion).toMatchObject({ state: 'queued' });
  });

  it('uses the short delay for a transient capacity condition', async () => {
    const world = newWorld();
    const { runtime } = runtimeFor(world, 'scanner_busy');
    const handlers = buildAshbyHandlers(runtime, { scannerGate: async () => ({ action: 'proceed', mode: 'clamav' }) });
    const result = await handlers[ASHBY_INGESTION_QUEUE](job());
    expect(result).toMatchObject({ outcome: 'defer', delaySeconds: 60 });
  });

  it('INFECTED remains terminal — never deferred, never retried', async () => {
    const world = newWorld();
    const { runtime } = runtimeFor(world, 'infected');
    const handlers = buildAshbyHandlers(runtime, { scannerGate: async () => ({ action: 'proceed', mode: 'clamav' }) });
    const result = await handlers[ASHBY_INGESTION_QUEUE](job());
    expect(result).toBeUndefined();
    expect(world.ingestion).toMatchObject({ state: 'failed_review' });
    expect(world.transitions.at(-1)).toMatchObject({ state: 'failed_review', reason: 'scan_infected' });
  });

  it('stops deferring at the wall-clock deadline and fails LOUDLY', async () => {
    const world = newWorld();
    const { runtime } = runtimeFor(world, 'scanner_signatures_unavailable');
    const handlers = buildAshbyHandlers(runtime, {
      scannerGate: async () => ({ action: 'proceed', mode: 'clamav' }),
      scannerDeferDeadlineMs: 8 * 3600_000,
      // Nine hours after the job was created: waiting has stopped being
      // correct and has become an invisible backlog.
      nowMs: () => Date.parse('2026-08-19T09:00:00.000Z'),
    });
    const result = await handlers[ASHBY_INGESTION_QUEUE](job());
    expect(result).toBeUndefined();
    expect(world.transitions.at(-1)).toMatchObject({
      state: 'failed_review', reason: DEFER_DEADLINE_REASON,
    });
  });

  it('rests the row when the bounded ingestion requeue ceiling refuses', async () => {
    const world = newWorld({
      advanceOverride: (state) => (state === 'queued' ? { status: 'retry_exhausted' } : null),
    });
    const { runtime } = runtimeFor(world, 'scanner_busy');
    const handlers = buildAshbyHandlers(runtime, { scannerGate: async () => ({ action: 'proceed', mode: 'clamav' }) });
    const result = await handlers[ASHBY_INGESTION_QUEUE](job());
    expect(result).toBeUndefined();
    expect(world.transitions.at(-1)).toMatchObject({
      state: 'failed_review', reason: DEFER_EXHAUSTED_REASON,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The handler-entry gate (belt to the admission gate's braces)
// ═══════════════════════════════════════════════════════════════════════

describe('handler-entry readiness gate', () => {
  it('defers with zero provider calls when a claim slips past the admission gate', async () => {
    const world = newWorld();
    const { runtime, buildIngestionPorts } = runtimeFor(world);
    const handlers = buildAshbyHandlers(runtime, {
      scannerGate: async () => ({ action: 'defer', mode: 'clamav', reasonCode: 'scanner_signatures_missing' }),
      scannerDeferSeconds: 45,
    });

    const result = await handlers[ASHBY_INGESTION_QUEUE](job());

    expect(result).toMatchObject({
      outcome: 'defer', reasonCode: 'scanner_signatures_missing', delaySeconds: 45,
    });
    // Checked while the row was still `queued`: the last free moment.
    expect(world.transitions).toEqual([]);
    expect(world.ingestion).toMatchObject({ state: 'queued' });
    expect(buildIngestionPorts).not.toHaveBeenCalled();
    expect(world.fileInfoCalls).toBe(0);
    expect(world.fetches).toBe(0);
  });

  it('two concurrent workers on a held scanner both defer and neither advances the row', async () => {
    const world = newWorld();
    const { runtime } = runtimeFor(world);
    const handlers = buildAshbyHandlers(runtime, {
      scannerGate: async () => ({ action: 'defer', mode: 'clamav', reasonCode: 'scanner_busy' }),
    });
    const [a, b] = await Promise.all([
      handlers[ASHBY_INGESTION_QUEUE](job({ id: 'job_a' })),
      handlers[ASHBY_INGESTION_QUEUE](job({ id: 'job_b' })),
    ]);
    expect(a).toMatchObject({ outcome: 'defer' });
    expect(b).toMatchObject({ outcome: 'defer' });
    expect(world.transitions).toEqual([]);
  });

  it('a terminal or resume-free link is still a no-op, ahead of any readiness question', async () => {
    const world = newWorld({ link: baseLink({ externalResumeFileHandle: null }) });
    const { runtime } = runtimeFor(world);
    const gate = vi.fn(async () => ({ action: 'defer' as const, mode: 'clamav' as const, reasonCode: 'scanner_busy' }));
    const handlers = buildAshbyHandlers(runtime, { scannerGate: gate });
    const result = await handlers[ASHBY_INGESTION_QUEUE](job());
    expect(result).toBeUndefined();
    // Nothing to ingest means nothing to wait for.
    expect(gate).not.toHaveBeenCalled();
  });
});
