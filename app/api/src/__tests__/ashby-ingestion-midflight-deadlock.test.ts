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
 * THE FAKE MODELS THE DATABASE ON PURPOSE. An `advanceIngestion` stub that
 * always answers `ok` cannot reproduce this defect at all — it would make
 * every test here green with the fix reverted, which is precisely the
 * false-green shape this repo has been bitten by before. The fake therefore
 * models three real things:
 *
 *   1. `enforce_ashby_ingestion_transition`'s allowed-edge map (faithful copy);
 *   2. `advance_ashby_ingestion`'s UNCONDITIONAL rewrite of `failed_reason` on
 *      a `-> failed_review` write, including the same-state no-op;
 *   3. its VERDICT-class refusal of `-> queued`.
 *
 * (2) and (3) together are what make the laundering regression below
 * observable at all: with a fake that ignores `failed_reason`, an adversarial
 * review had to find it by reading SQL.
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
  MIDFLIGHT_RECENTLY_ACTIVE_REASON,
  DEFAULT_MIDFLIGHT_RECHECK_SECONDS,
  FETCHING_ENTRY_REFUSED_REASON,
} from '../integrations/ashby/runtime-workers.js';
import { PARSE_CLASSIFIER } from '../integrations/ashby/resume-ingestion.js';
import { ParserError } from '../lib/resume-parser.js';
import type { WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

/**
 * Faithful copy of the trigger as 0097 LEAVES it — i.e. unchanged from 0084.
 * `scanning -> fetching` is not here, which is the deadlock. Note
 * `structuring` has no `queued` edge: 0097 deliberately does not add one.
 */
const ALLOWED: Record<string, readonly string[]> = {
  queued: ['fetching', 'cancelled'],
  fetching: ['scanning', 'failed_review', 'cancelled', 'queued'],
  scanning: ['extracting', 'failed_review', 'cancelled', 'queued'],
  extracting: ['structuring', 'failed_review', 'cancelled', 'queued'],
  structuring: ['ready', 'failed_review', 'cancelled'],
  failed_review: ['queued', 'cancelled'],
  ready: ['queued'],
  cancelled: [],
};

/** `advance_ashby_ingestion`'s verdict-class refusal of a generic requeue. */
const VERDICT_REASONS = [
  'scan_infected', 'parse_error', 'parse_extract_failed', 'parse_bad_output',
  'parse_no_output', 'parse_output_exceeded', 'no_extractable_fields',
];
function requeueRefused(reason: string | null): boolean {
  return reason !== null
    && (VERDICT_REASONS.includes(reason) || reason.startsWith('guard_'));
}

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: 'handle_1', jobMappingId: 'map_1',
    candidateId: 'cand_shell_1', sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

interface Row { state: string; attempts: number; failedReason: string | null }

interface World {
  link: WorkflowLinkRow;
  ingestion: Row;
  transitions: Array<{ state: string; reason?: string }>;
  entryRefusals: number;
  midflight: Array<{ linkId: string; reason: string; from: string }>;
  midflightResult: { status: string; attempts?: number };
  omitMidflightSeam?: boolean;
  midflightThrows?: boolean;
  /** Make every `-> failed_review` write refuse, so the rest cannot land. */
  restRefused?: boolean;
  /** Make `readIngestion` throw, as a transport error really does. */
  readThrows?: boolean;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    link: baseLink(),
    ingestion: { state: 'queued', attempts: 0, failedReason: null },
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
    readIngestion: async () => {
      // A real transport error THROWS (`ashby_ingestion_read_error`); `null` is
      // the distinct "no row" answer. Modelling both is what makes the
      // fail-closed assertion below possible at all.
      if (world.readThrows) throw new Error('ashby_ingestion_read_error');
      return { ...world.ingestion };
    },
    advanceIngestion: async (_id: string, state: string, prov?: { failedReason?: string }) => {
      if (world.restRefused && state === 'failed_review') {
        return { status: 'invalid_transition' };
      }
      const from = world.ingestion.state;
      if (from !== state && !(ALLOWED[from] ?? []).includes(state)) {
        if (state === 'fetching') world.entryRefusals += 1;
        return { status: 'invalid_transition' };
      }
      // The generic requeue refuses a verdict-class rest.
      if (state === 'queued' && requeueRefused(world.ingestion.failedReason)) {
        return { status: 'not_requeueable', state: from };
      }
      world.transitions.push({ state, reason: prov?.failedReason });
      world.ingestion = {
        ...world.ingestion,
        state,
        // Modelled from the RPC: the reason is rewritten UNCONDITIONALLY on a
        // `failed_review` write (same-state included) and cleared on `queued`.
        failedReason: state === 'failed_review'
          ? (prov?.failedReason ?? 'failed')
          : state === 'queued' ? null : world.ingestion.failedReason,
      };
      return { status: 'ok' };
    },
  };
  if (!world.omitMidflightSeam) {
    stores.resumeIngestionMidflight = async (linkId: string, reason: string) => {
      if (world.midflightThrows) throw new Error('transport');
      world.midflight.push({ linkId, reason, from: world.ingestion.state });
      if (world.midflightResult.status === 'ok') {
        world.ingestion = {
          state: 'queued', attempts: world.ingestion.attempts + 1, failedReason: null,
        };
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

const run = (world: World, j = job()) =>
  buildAshbyHandlers(runtimeFor(world), { nowMs: () => NOW })[ASHBY_INGESTION_QUEUE]!(j);

describe('a row a dead process left mid-flight is re-driven, not abandoned', () => {
  for (const state of ['scanning', 'extracting']) {
    it(`rescues a row stranded in ${state} and runs the pipeline again`, async () => {
      const world = newWorld({ ingestion: { state, attempts: 1, failedReason: null } });
      await run(world);

      expect(world.midflight).toEqual([
        { linkId: 'link_1', reason: MIDFLIGHT_RESUME_REASON, from: state },
      ]);
      // THE REGRESSION. Before the fix the entry transition was refused and the
      // handler returned bare, leaving both of these untouched.
      expect(world.entryRefusals).toBe(0);
      expect(world.transitions.map((t) => t.state)).toContain('fetching');
      // And the run reached a REAL verdict rather than evaporating.
      expect(world.ingestion.state).toBe('failed_review');
      expect(world.ingestion.failedReason).toBe('parse_error');
    });
  }

  it('does NOT rescue structuring — it is post-persist and re-driving corrupts it', async () => {
    // `structuring` runs AFTER persist has bound the candidate, and
    // `updateCandidateFromParse` is CAS-guarded on `resume_id is null`, so a
    // re-drive silently discards the second parse and strands the candidate
    // outside `recover_ashby_model_degraded`. The health surface counts it
    // instead. Guarding the exclusion so nobody "completes the set" later.
    expect(MIDFLIGHT_INGESTION_STATES.has('structuring')).toBe(false);
    const world = newWorld({
      ingestion: { state: 'structuring', attempts: 1, failedReason: null },
    });
    await run(world);
    expect(world.midflight).toEqual([]);
  });

  it('leaves a healthy queued row alone — no rescue, no extra attempt', async () => {
    const world = newWorld({ ingestion: { state: 'queued', attempts: 0, failedReason: null } });
    await run(world);
    expect(world.midflight).toEqual([]);
    expect(world.ingestion.attempts).toBe(0);
  });

  it('leaves a healthy fetching row alone — it self-heals as a no-op', async () => {
    const world = newWorld({ ingestion: { state: 'fetching', attempts: 0, failedReason: null } });
    await run(world);
    expect(world.midflight).toEqual([]);
  });

  it('the rescued set is exactly the safe states that cannot reach fetching', async () => {
    for (const state of MIDFLIGHT_INGESTION_STATES) {
      expect((ALLOWED[state] ?? []).includes('fetching')).toBe(false);
      // ...and CAN reach `queued`, or the rescue would be impossible.
      expect((ALLOWED[state] ?? []).includes('queued')).toBe(true);
    }
    for (const state of ['queued', 'fetching', 'structuring']) {
      expect(MIDFLIGHT_INGESTION_STATES.has(state)).toBe(false);
    }
  });
});

describe('a live run is never yanked backwards', () => {
  it('WAITS instead of failing when the row was touched recently', async () => {
    // The lease is not the process: the runner keeps running a handler whose
    // heartbeat failed, and the reclaim sweep requeues with no liveness proof.
    // So a second worker can land here while the first is still downloading.
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      midflightResult: { status: 'recently_active' },
    });
    const r = await run(world);
    expect(r).toEqual({
      outcome: 'defer',
      reasonCode: MIDFLIGHT_RECENTLY_ACTIVE_REASON,
      delaySeconds: DEFAULT_MIDFLIGHT_RECHECK_SECONDS,
    });
    // Critically: the live row was NOT written off.
    expect(world.transitions).toEqual([]);
    expect(world.ingestion.state).toBe('scanning');
  });
});

describe('a rescue that cannot happen is written down, never silent', () => {
  it('rests loudly when the recovery seam is absent', async () => {
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      omitMidflightSeam: true,
    });
    await run(world);
    expect(world.ingestion.failedReason).toBe(MIDFLIGHT_RESUME_UNAVAILABLE_REASON);
  });

  it('rests loudly when the row has burned its retry budget', async () => {
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 5, failedReason: null },
      midflightResult: { status: 'retry_exhausted' },
    });
    await run(world);
    expect(world.ingestion.failedReason).toBe(MIDFLIGHT_RESUME_EXHAUSTED_REASON);
  });

  it('rests loudly on any other refusal', async () => {
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      midflightResult: { status: 'invalid_state' },
    });
    await run(world);
    expect(world.ingestion.failedReason).toBe(MIDFLIGHT_RESUME_REFUSED_REASON);
  });

  it('stays silent ONLY when the application itself went terminal', async () => {
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      midflightResult: { status: 'blocked_terminal' },
    });
    await run(world);
    expect(world.transitions).toEqual([]);
  });

  it('records the reason on the LAST attempt when the seam throws', async () => {
    // A transport failure must not dead-letter with the row stranded and no
    // reason — that is the original incident's durable symptom.
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      midflightThrows: true,
    });
    await expect(run(world, job({ attempts: 5, maxAttempts: 5 }))).rejects.toThrow();
    expect(world.ingestion.failedReason).toBe(MIDFLIGHT_RESUME_UNAVAILABLE_REASON);
  });

  it('does NOT rest on an early attempt when the seam throws — it retries', async () => {
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      midflightThrows: true,
    });
    await expect(run(world, job({ attempts: 1, maxAttempts: 5 }))).rejects.toThrow();
    expect(world.transitions).toEqual([]);
  });
});

describe('an already-rested row keeps its verdict — the laundering regression', () => {
  it('NEVER overwrites failed_reason on a row already resting', async () => {
    // THE SECURITY PROPERTY. `failed_review` is not terminal and
    // `failed_review -> failed_review` is a same-state no-op the trigger waves
    // through, so a naive "always record a reason" would rewrite `scan_infected`
    // as a machine-class code.
    const world = newWorld({
      ingestion: { state: 'failed_review', attempts: 1, failedReason: 'scan_infected' },
    });
    await run(world);
    expect(world.ingestion.failedReason).toBe('scan_infected');
    expect(world.transitions).toEqual([]);
  });

  it('so a known-infected résumé is still refused a requeue afterwards', async () => {
    // The consequence, asserted end-to-end rather than as a string comparison:
    // had the reason been laundered, the verdict guard would no longer match
    // and the pipeline would re-download and re-scan the infected file.
    const world = newWorld({
      ingestion: { state: 'failed_review', attempts: 1, failedReason: 'scan_infected' },
    });
    await run(world);
    // `requeueRefused` is the same predicate the fake uses to model
    // `advance_ashby_ingestion`'s verdict guard, so this asserts the ACTUAL
    // consequence: the row the handler left behind is still one the generic
    // requeue refuses. A laundered reason would flip this to false and the
    // infected file would be re-downloaded.
    expect(requeueRefused(world.ingestion.failedReason)).toBe(true);
  });

  it.each(['guard_mime_rejected', 'parse_bad_output', 'no_extractable_fields'])(
    'preserves the %s verdict too', async (verdict) => {
      const world = newWorld({
        ingestion: { state: 'failed_review', attempts: 1, failedReason: verdict },
      });
      await run(world);
      expect(world.ingestion.failedReason).toBe(verdict);
    },
  );
});

describe('the rest primitive itself cannot fail quietly', () => {
  it('THROWS when the rest could not land, instead of completing the job', async () => {
    // `restOrEscalate`'s whole reason to exist is this branch: a rest that
    // does not land and is not escalated is a job that reports success having
    // neither done the work nor recorded why — the original defect. Without
    // this test, deleting the `throw` leaves the suite green.
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      midflightResult: { status: 'invalid_state' },
      restRefused: true,
    });
    await expect(run(world)).rejects.toThrow(/ashby_ingestion_rest_failed/);
    expect(world.ingestion.failedReason).toBeNull();
  });

  it('FAILS CLOSED when the guarding read throws — it never writes on a guess', async () => {
    // The read decides whether a live ingestion gets written off and whether a
    // verdict survives. Collapsing a transport error to `null` (the old
    // `.catch(() => null)`) would skip every guard and rest the row anyway.
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      midflightResult: { status: 'invalid_state' },
      readThrows: true,
    });
    await expect(run(world)).rejects.toThrow(/ashby_ingestion_read_error/);
    expect(world.transitions).toEqual([]);
  });

  it('leaves a verdict alone even when the refusal arrives from the RESCUE', async () => {
    // `invalid_state` is what the RPC returns precisely when the row moved out
    // from under us — including to `failed_review/scan_infected`. This is the
    // path that wrote unguarded before the guard moved into the primitive.
    const world = newWorld({
      ingestion: { state: 'scanning', attempts: 1, failedReason: null },
      midflightResult: { status: 'invalid_state' },
    });
    // The row is rested by "another worker" the moment the rescue is asked.
    const runtime = runtimeFor(world);
    const stores = (runtime as unknown as { stores: Record<string, unknown> }).stores;
    const original = stores.resumeIngestionMidflight as (l: string, r: string) => Promise<unknown>;
    stores.resumeIngestionMidflight = async (l: string, r: string) => {
      const out = await original(l, r);
      world.ingestion = { state: 'failed_review', attempts: 1, failedReason: 'scan_infected' };
      return out;
    };
    await buildAshbyHandlers(runtime as never, { nowMs: () => NOW })[ASHBY_INGESTION_QUEUE]!(job());
    expect(world.ingestion.failedReason).toBe('scan_infected');
    expect(requeueRefused(world.ingestion.failedReason)).toBe(true);
  });
});

describe('the entry transition never completes a job in silence again', () => {
  it('records a reason when -> fetching is refused for an unknown cause', async () => {
    // A row resting on a MACHINE-class reason carries no verdict to protect, so
    // the refusal is recorded rather than swallowed. `materialize_failed` is in
    // the audited recovery allowlist, so this is a legal, non-verdict rest.
    const world = newWorld({
      ingestion: { state: 'failed_review', attempts: 1, failedReason: 'materialize_failed' },
    });
    await run(world);
    // The row is already rested, so the handler leaves it exactly as it found
    // it — the reason it carries is already truthful.
    expect(world.entryRefusals).toBe(1);
    expect(world.ingestion.failedReason).toBe('materialize_failed');
  });

  it('stays silent when the row is already terminal — and proves the guard fired', async () => {
    const world = newWorld({
      ingestion: { state: 'cancelled', attempts: 1, failedReason: null },
    });
    await run(world);
    expect(world.transitions).toEqual([]);
    expect(world.midflight).toEqual([]);
    // Without this the test passes even with the terminal guard DELETED: the
    // handler would fall through, be refused at `-> fetching`, read `cancelled`
    // back, and return silently anyway. The counter is what distinguishes
    // "returned at the guard" from "returned three steps later by luck".
    expect(world.entryRefusals).toBe(0);
  });
});
