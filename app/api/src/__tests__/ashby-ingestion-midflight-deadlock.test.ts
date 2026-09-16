/**
 * The mid-flight deadlock (RCA 2026-09-16, migration 0097).
 *
 * A process killed between `onState('scanning')` and its verdict leaves the
 * durable row in `scanning`. The handler's terminal guard is
 * `{ready, cancelled}`, so the row sails through it; the handler's entry
 * transition is `-> fetching`, which the trigger does NOT allow from
 * `scanning`; and the old code read the refusal and `return`ed bare. The JOB
 * was marked completed and the ROW was frozen for ever, with no failure
 * reason and no health counter. Two résumés were lost exactly this way.
 *
 * THE FAKE MODELS THE TRIGGER ON PURPOSE. An `advanceIngestion` stub that
 * always answers `ok` cannot reproduce this defect at all — it would make
 * every test here green with the fix reverted, which is precisely the
 * false-green shape this repo has been bitten by before. The allowed-edge map
 * below is a faithful copy of `enforce_ashby_ingestion_transition` as 0097
 * leaves it, and `entryRefusals` proves it actually fires.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
  MIDFLIGHT_INGESTION_STATES,
  MIDFLIGHT_RESUME_REASON,
  MIDFLIGHT_RESUME_EXHAUSTED_REASON,
  MIDFLIGHT_RESUME_REFUSED_REASON,
  MIDFLIGHT_RESUME_UNAVAILABLE_REASON,
  FETCHING_ENTRY_REFUSED_REASON,
} from '../integrations/ashby/runtime-workers.js';
import { PARSE_CLASSIFIER } from '../integrations/ashby/resume-ingestion.js';
import { ParserError } from '../lib/resume-parser.js';
import type { WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

/** Faithful copy of the 0097 trigger. `scanning -> fetching` is NOT here. */
const ALLOWED: Record<string, readonly string[]> = {
  queued: ['fetching', 'cancelled'],
  fetching: ['scanning', 'failed_review', 'cancelled', 'queued'],
  scanning: ['extracting', 'failed_review', 'cancelled', 'queued'],
  extracting: ['structuring', 'failed_review', 'cancelled', 'queued'],
  structuring: ['ready', 'failed_review', 'cancelled', 'queued'],
  failed_review: ['queued', 'cancelled'],
  ready: ['queued'],
  cancelled: [],
};

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
  entryRefusals: number;
  midflight: Array<{ linkId: string; reason: string; from: string }>;
  midflightResult: { status: string; attempts?: number };
  omitMidflightSeam?: boolean;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    link: baseLink(),
    ingestion: { state: 'queued', attempts: 0 },
    transitions: [],
    entryRefusals: 0,
    midflight: [],
    midflightResult: { status: 'ok', attempts: 1 },
    ...over,
  };
}

function runtimeFor(world: World) {
  const stores: Record<string, unknown> = {
    readLink: async () => world.link,
    readIngestion: async () => ({ ...world.ingestion }),
    advanceIngestion: async (_id: string, state: string, prov?: { failedReason?: string }) => {
      const from = world.ingestion.state;
      if (from !== state && !(ALLOWED[from] ?? []).includes(state)) {
        if (state === 'fetching') world.entryRefusals += 1;
        return { status: 'invalid_transition' };
      }
      world.transitions.push({ state, reason: prov?.failedReason });
      world.ingestion = { ...world.ingestion, state };
      return { status: 'ok' };
    },
  };
  if (!world.omitMidflightSeam) {
    stores.resumeIngestionMidflight = async (linkId: string, reason: string) => {
      world.midflight.push({ linkId, reason, from: world.ingestion.state });
      if (world.midflightResult.status === 'ok') {
        world.ingestion = { state: 'queued', attempts: world.ingestion.attempts + 1 };
      }
      return world.midflightResult;
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
        fetch: async () => ({
          ok: true as const, bytes: Buffer.from([0xde, 0xad, 0xbe, 0xef]), sha256: 'a'.repeat(64),
          contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
        }),
        scan: async () => ({ safe: true, status: 'clean' }),
        guard: () => ({ ok: true as const, mime: 'application/pdf' }),
        // A PERMANENT parse verdict: the run is driven all the way to a real
        // terminal state, so "the pipeline actually ran" is observable and
        // cannot be confused with the silent stall this file is about.
        parse: async () => { throw new ParserError('parse_error'); },
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

const run = (world: World) =>
  buildAshbyHandlers(runtimeFor(world), { nowMs: () => NOW })[ASHBY_INGESTION_QUEUE]!(job());

describe('a row a dead process left mid-flight is re-driven, not abandoned', () => {
  for (const state of ['scanning', 'extracting', 'structuring']) {
    it(`rescues a row stranded in ${state} and runs the pipeline again`, async () => {
      const world = newWorld({ ingestion: { state, attempts: 1 } });
      await run(world);

      // The rescue happened, from the state the dead run left behind.
      expect(world.midflight).toEqual([
        { linkId: 'link_1', reason: MIDFLIGHT_RESUME_REASON, from: state },
      ]);
      // THE REGRESSION. Before the fix these were both zero-length/untouched:
      // the entry transition was refused and the handler returned bare.
      expect(world.entryRefusals).toBe(0);
      expect(world.transitions.map((t) => t.state)).toContain('fetching');
      // And the run reached a REAL verdict rather than evaporating.
      expect(world.ingestion.state).toBe('failed_review');
      expect(world.transitions.at(-1)!.reason).toBe('parse_error');
    });
  }

  it('leaves a healthy queued row alone — no rescue, no extra attempt', async () => {
    const world = newWorld({ ingestion: { state: 'queued', attempts: 0 } });
    await run(world);
    expect(world.midflight).toEqual([]);
    expect(world.ingestion.attempts).toBe(0);
  });

  it('leaves a healthy fetching row alone — it self-heals as a no-op', async () => {
    // `fetching -> fetching` is idempotent, so a live download must NOT be
    // yanked backwards by another worker deciding to "rescue" it.
    const world = newWorld({ ingestion: { state: 'fetching', attempts: 0 } });
    await run(world);
    expect(world.midflight).toEqual([]);
  });

  it('the rescued set is exactly the states that cannot reach fetching', async () => {
    // The asymmetry is the whole bug: the two states the health surface used
    // to watch are the two that need no rescue.
    for (const state of MIDFLIGHT_INGESTION_STATES) {
      expect((ALLOWED[state] ?? []).includes('fetching')).toBe(false);
    }
    for (const state of ['queued', 'fetching']) {
      expect(MIDFLIGHT_INGESTION_STATES.has(state)).toBe(false);
    }
  });
});

describe('a rescue that cannot happen is written down, never silent', () => {
  it('rests loudly when the recovery seam is absent', async () => {
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1 }, omitMidflightSeam: true,
    });
    await run(world);
    expect(world.transitions).toEqual([
      { state: 'failed_review', reason: MIDFLIGHT_RESUME_UNAVAILABLE_REASON },
    ]);
  });

  it('rests loudly when the row has burned its retry budget', async () => {
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 5 },
      midflightResult: { status: 'retry_exhausted' },
    });
    await run(world);
    expect(world.transitions).toEqual([
      { state: 'failed_review', reason: MIDFLIGHT_RESUME_EXHAUSTED_REASON },
    ]);
  });

  it('rests loudly on any other refusal', async () => {
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1 },
      midflightResult: { status: 'invalid_state' },
    });
    await run(world);
    expect(world.transitions).toEqual([
      { state: 'failed_review', reason: MIDFLIGHT_RESUME_REFUSED_REASON },
    ]);
  });

  it('stays silent ONLY when the application itself went terminal', async () => {
    // Nothing to rest: the row is dead because the application is gone.
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1 },
      midflightResult: { status: 'blocked_terminal' },
    });
    await run(world);
    expect(world.transitions).toEqual([]);
  });
});

describe('the entry transition never completes a job in silence again', () => {
  it('records a reason when -> fetching is refused for an unknown cause', async () => {
    // The rescue is bypassed (the state is not mid-flight) but the edge is
    // still illegal — the residual case the old bare `return` swallowed.
    const world = newWorld({ ingestion: { state: 'failed_review', attempts: 1 } });
    await run(world);
    expect(world.entryRefusals).toBe(1);
    expect(world.transitions).toEqual([
      { state: 'failed_review', reason: FETCHING_ENTRY_REFUSED_REASON },
    ]);
  });

  it('stays silent when the row is already terminal', async () => {
    // `cancelled` is terminal, so the handler returns at the guard before it
    // ever reaches the entry transition.
    const world = newWorld({ ingestion: { state: 'cancelled', attempts: 1 } });
    await run(world);
    expect(world.transitions).toEqual([]);
    expect(world.midflight).toEqual([]);
  });
});
