/**
 * Ashby signal worker — the local stage pre-filter, and its fail-open contract.
 *
 * PRODUCTION INCIDENT (2026-09-16). An external bulk stage-move pushed ~8,700
 * applications through a stage this tenant has never mapped: 8,693 webhook
 * events across 8,693 DISTINCT applications, sustained at ~120/min. Every one
 * bought a full `application.info` round-trip BEFORE the mapping check could
 * reject it, which capped drain at ~30/min — a quarter of the inflow — so the
 * queue grew without bound and buried two real candidates.
 *
 * Reconciliation already refuses to enqueue applications outside the enabled
 * mappings; its own comment calls the omission "the tenant-wide signal storm
 * this loop exists to avoid". The webhook path never got the same admission
 * check. The pre-filter closes that asymmetry.
 *
 * The filter is a HINT, never truth. It may only ever cause MORE work than
 * strictly necessary, never less, so these tests are weighted towards proving
 * every uncertain condition still reaches the provider:
 *   no seam · unparseable id · truncated id · `nostage` sentinel · a throwing
 *   filter · a truncated mapping read · an empty mapping read.
 *
 * And the skip must stay CONDITIONAL: no receipt `mark`, so the row remains
 * `received` and a later mapping change plus a full resync can still re-drive
 * it (finding B2). Terminalising it would permanently poison that
 * application-at-stage, which is the exact bug `ashby-signal-nonterminal`
 * exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import {
  processAshbySignal,
  stageIdFromWebhookActionId,
  MAX_WEBHOOK_ACTION_ID_LEN,
  NO_STAGE_SENTINEL,
  type SignalWorkerDeps,
} from '../integrations/ashby/signal-worker.js';
import {
  createStageInterestFilter,
  buildAshbyHandlers,
  STAGE_INTEREST_CACHE_MS,
  STAGE_INTEREST_MAX_MAPPINGS,
  STAGE_INTEREST_READ_TIMEOUT_MS,
  STAGE_INTEREST_FAILURE_BACKOFF_MS,
  ASHBY_INGESTION_QUEUE,
} from '../integrations/ashby/runtime-workers.js';
import { MAX_ID_LEN } from '../integrations/ashby/extractors.js';
import { DEFAULT_MAX_ENABLED_MAPPINGS } from '../integrations/ashby/reconciliation.js';
import { ASHBY_SIGNAL_QUEUE } from '../integrations/ashby/signal-worker.js';
import { stageDedupId, CANDIDATE_STAGE_CHANGE_ACTION } from '../integrations/ashby/extractors.js';
import type {
  AshbySignalPayload, EnabledMappingLoader, EnabledMappingRow,
} from '../integrations/ashby/ports.js';
import type { AshbyResult, OpaqueRecord } from '../integrations/ashby/types.js';

const APP = 'app_1';
const JOB = 'job_1';
const AI_STAGE = 'stage_ai';
const UNMAPPED_STAGE = 'stage_bulk_noise';

/** Counts provider reads so a "skip" can be proven to have cost nothing. */
function makeClient(stageId: string = AI_STAGE): {
  reads: number;
  applicationInfo<T = OpaqueRecord>(id: string): Promise<AshbyResult<T>>;
} {
  return {
    reads: 0,
    async applicationInfo<T = OpaqueRecord>(): Promise<AshbyResult<T>> {
      this.reads += 1;
      return {
        ok: true,
        results: { id: APP, job: { id: JOB }, currentInterviewStage: { id: stageId } },
      } as unknown as AshbyResult<T>;
    },
  };
}

function baseDeps(client: ReturnType<typeof makeClient>): SignalWorkerDeps {
  return {
    client,
    mappings: { resolveByJobId: async () => ({ status: 'enabled', aiScreeningStageId: AI_STAGE }) },
  };
}

function payloadFor(stageId: string): AshbySignalPayload {
  return {
    provider: 'ashby',
    action: CANDIDATE_STAGE_CHANGE_ACTION,
    webhookActionId: stageDedupId(APP, stageId),
    externalApplicationId: APP,
  };
}

describe('stageIdFromWebhookActionId — refuses every ambiguous id', () => {
  it('extracts the stage id from a well-formed receipt identity', () => {
    expect(stageIdFromWebhookActionId(stageDedupId(APP, UNMAPPED_STAGE))).toBe(UNMAPPED_STAGE);
  });

  it('returns null for the nostage sentinel, which means "stage unknown"', () => {
    // stageDedupId substitutes this when the signal carried no stage. Treating
    // it as a stage id would match no mapping and skip the one case that most
    // needs the authoritative read.
    expect(stageIdFromWebhookActionId(stageDedupId(APP, undefined))).toBeNull();
    expect(stageIdFromWebhookActionId(`stage:${APP}:${NO_STAGE_SENTINEL}`)).toBeNull();
  });

  it('derives its bound from the extractor, so the two cannot drift', () => {
    // The drift that matters is MAX_ID_LEN SHRINKING: stageDedupId would slice
    // at the smaller bound while this guard still rejected only at the larger,
    // so a truncated identity would be ACCEPTED and its truncated stage segment
    // would authorise a skip — exactly what the derivation exists to prevent.
    expect(MAX_WEBHOOK_ACTION_ID_LEN).toBe(MAX_ID_LEN);
  });

  it('returns null for an id at the truncation bound', () => {
    // stageDedupId slices at MAX_ID_LEN, so the trailing stage segment of a
    // max-length id may be a prefix of the real one.
    const longStage = 'z'.repeat(MAX_WEBHOOK_ACTION_ID_LEN);
    const truncated = stageDedupId(APP, longStage);
    expect(truncated.length).toBe(MAX_WEBHOOK_ACTION_ID_LEN);
    expect(stageIdFromWebhookActionId(truncated)).toBeNull();
  });

  it('returns null for shapes it does not recognise', () => {
    for (const bad of [
      undefined, null, 42, '', 'stage', 'stage:only_two', 'stage:a:b:c',
      'notstage:a:b', 'stage::b', 'stage:a:',
    ]) {
      expect(stageIdFromWebhookActionId(bad)).toBeNull();
    }
  });
});

describe('processAshbySignal — the pre-filter skips only a definite "no"', () => {
  it('skips the provider read for a stage no mapping names, non-terminally', async () => {
    const client = makeClient();
    const marks: string[] = [];
    const result = await processAshbySignal(payloadFor(UNMAPPED_STAGE), {
      ...baseDeps(client),
      receipts: {
        record: async () => ({ status: 'inserted', id: 'r1', enqueued: false, workPending: false }),
        markStatus: async (i) => { marks.push(i.status); },
      },
      isStageOfInterest: (stageId) => stageId === AI_STAGE,
    });

    expect(result.decision).toBe('stage_not_of_interest');
    expect(result.stageId).toBe(UNMAPPED_STAGE);
    // The whole point: no provider round-trip was spent.
    expect(client.reads).toBe(0);
    // CONDITIONAL — the receipt must stay `received` so a later mapping change
    // plus a full resync can still re-drive this application.
    expect(marks).toEqual([]);
  });

  it('does the authoritative read for a stage a mapping does name', async () => {
    const client = makeClient(AI_STAGE);
    const result = await processAshbySignal(payloadFor(AI_STAGE), {
      ...baseDeps(client),
      isStageOfInterest: (stageId) => stageId === AI_STAGE,
    });
    expect(client.reads).toBe(1);
    expect(result.decision).toBe('import_eligible');
  });

  it('is byte-identical to the old path when no filter is wired', async () => {
    const client = makeClient(AI_STAGE);
    const result = await processAshbySignal(payloadFor(UNMAPPED_STAGE), baseDeps(client));
    // No seam ⇒ no fast path ⇒ the provider decides, exactly as before.
    expect(client.reads).toBe(1);
    expect(result.decision).toBe('import_eligible');
  });

  it('fails OPEN when the filter throws', async () => {
    const client = makeClient(AI_STAGE);
    const result = await processAshbySignal(payloadFor(UNMAPPED_STAGE), {
      ...baseDeps(client),
      isStageOfInterest: () => { throw new Error('mapping_read_down'); },
    });
    expect(client.reads).toBe(1);
    expect(result.decision).toBe('import_eligible');
  });

  it('fails OPEN when the filter rejects', async () => {
    const client = makeClient(AI_STAGE);
    const result = await processAshbySignal(payloadFor(UNMAPPED_STAGE), {
      ...baseDeps(client),
      isStageOfInterest: async () => { throw new Error('async_boom'); },
    });
    expect(client.reads).toBe(1);
    expect(result.decision).toBe('import_eligible');
  });

  it('fails OPEN on an unparseable receipt identity', async () => {
    const client = makeClient(AI_STAGE);
    let asked = 0;
    const result = await processAshbySignal(
      { ...payloadFor(AI_STAGE), webhookActionId: 'not-a-stage-identity' },
      { ...baseDeps(client), isStageOfInterest: () => { asked += 1; return false; } },
    );
    // Never even consulted — there was no trustworthy stage id to consult with.
    expect(asked).toBe(0);
    expect(client.reads).toBe(1);
    expect(result.decision).toBe('import_eligible');
  });

  it('treats a non-boolean answer as "cannot answer", not as a skip', async () => {
    // Only a literal `false` may grant a skip. A seam returning undefined/null
    // must cost a provider read, never a dropped candidate.
    for (const answer of [undefined, null, 0, '', 'false']) {
      const client = makeClient(AI_STAGE);
      const result = await processAshbySignal(payloadFor(UNMAPPED_STAGE), {
        ...baseDeps(client),
        isStageOfInterest: (() => answer) as unknown as (s: string) => boolean,
      });
      expect(client.reads).toBe(1);
      expect(result.decision).toBe('import_eligible');
    }
  });

  it('fails open when the identity names a different application than the payload', async () => {
    const client = makeClient(AI_STAGE);
    let asked = 0;
    const result = await processAshbySignal(
      {
        ...payloadFor(UNMAPPED_STAGE),
        webhookActionId: stageDedupId('some_other_app', UNMAPPED_STAGE),
      },
      { ...baseDeps(client), isStageOfInterest: () => { asked += 1; return false; } },
    );
    expect(asked).toBe(0);
    expect(client.reads).toBe(1);
    expect(result.decision).toBe('import_eligible');
  });

  it('reports the hint against authoritative truth on the path that already read', async () => {
    // The ONLY way to learn the hint is wrong: the skip path never reads, so
    // without this a systematically wrong hint is undetectable forever.
    const observed: Array<{ hintedStageId: string; authoritativeStageId: string | undefined }> = [];
    const client = makeClient(AI_STAGE);
    await processAshbySignal(payloadFor(AI_STAGE), {
      ...baseDeps(client),
      isStageOfInterest: () => true,
      onStageHintObserved: (i) => { observed.push(i); },
    });
    expect(observed).toEqual([{ hintedStageId: AI_STAGE, authoritativeStageId: AI_STAGE }]);
  });

  it('surfaces a MISMATCH between hint and authoritative stage', async () => {
    const observed: Array<{ hintedStageId: string; authoritativeStageId: string | undefined }> = [];
    // Payload hints one stage; the provider says the application is elsewhere.
    const client = makeClient(AI_STAGE);
    await processAshbySignal(payloadFor('stage_stale_hint'), {
      ...baseDeps(client),
      isStageOfInterest: () => true,
      onStageHintObserved: (i) => { observed.push(i); },
    });
    expect(observed).toEqual([
      { hintedStageId: 'stage_stale_hint', authoritativeStageId: AI_STAGE },
    ]);
  });

  it('observes the hint on the paths that do NOT import — the evidence that matters', async () => {
    // Placement is the entire point. Moving the observer below the early
    // returns would leave it reporting only signals whose hint already landed
    // on the mapped AI stage — structurally incapable of catching a wrong hint.
    // `stage_not_ai` is the PRIMARY evidence class for a systematically wrong
    // hint, so it must be observed.
    const seen: string[] = [];
    const clientOther = makeClient('stage_somewhere_else');
    const notAi = await processAshbySignal(payloadFor(UNMAPPED_STAGE), {
      ...baseDeps(clientOther),
      onStageHintObserved: (i) => { seen.push(`${i.hintedStageId}->${i.authoritativeStageId}`); },
    });
    expect(notAi.decision).toBe('stage_not_ai');
    expect(seen).toEqual([`${UNMAPPED_STAGE}->stage_somewhere_else`]);

    // ...and on mapping_inactive.
    const seen2: string[] = [];
    const client2 = makeClient(AI_STAGE);
    const inactive = await processAshbySignal(payloadFor(UNMAPPED_STAGE), {
      client: client2,
      mappings: { resolveByJobId: async () => ({ status: 'paused' }) },
      onStageHintObserved: (i) => { seen2.push(`${i.hintedStageId}->${i.authoritativeStageId}`); },
    });
    expect(inactive.decision).toBe('mapping_inactive');
    expect(seen2).toEqual([`${UNMAPPED_STAGE}->${AI_STAGE}`]);
  });

  it('never lets a throwing observer fail the signal', async () => {
    const client = makeClient(AI_STAGE);
    const result = await processAshbySignal(payloadFor(AI_STAGE), {
      ...baseDeps(client),
      onStageHintObserved: () => { throw new Error('metrics_down'); },
    });
    expect(result.decision).toBe('import_eligible');
  });

  it('never runs the filter before the action gate', async () => {
    const client = makeClient();
    let asked = 0;
    const result = await processAshbySignal(
      { ...payloadFor(AI_STAGE), action: 'applicationUpdate' },
      { ...baseDeps(client), isStageOfInterest: () => { asked += 1; return false; } },
    );
    expect(result.decision).toBe('ignored_action');
    expect(asked).toBe(0);
    expect(client.reads).toBe(0);
  });
});

/** Mapping loader stub with controllable truncation and failure. */
function loader(rows: EnabledMappingRow[], opts: { truncated?: boolean } = {}): {
  calls: number; limits: unknown[]; loader: EnabledMappingLoader;
} {
  const state = { calls: 0, limits: [] as unknown[] };
  return {
    get calls() { return state.calls; },
    get limits() { return state.limits; },
    loader: {
      async listEnabled(limit: number): Promise<{ rows: EnabledMappingRow[]; truncated: boolean }> {
        state.calls += 1;
        // Recorded so a test can prove the BOUND reaches the port. The real
        // loader does Math.trunc(limit) — an omitted argument becomes NaN and
        // silently poisons the query, which a zero-arg stub would never catch.
        state.limits.push(limit);
        return { rows, truncated: opts.truncated === true };
      },
    },
  };
}

describe('buildAshbyHandlers — the pre-filter is actually WIRED, and built once', () => {
  /**
   * Without this, the entire optimisation can be reverted by deleting one
   * spread in the signal handler, or silently neutered by constructing the
   * filter per job (defeating its cache), and every other test stays green.
   */
  function stubRuntime(reads: { n: number }, loaderCalls: { n: number }) {
    return {
      client: {
        async applicationInfo() {
          reads.n += 1;
          return {
            ok: true,
            results: { id: APP, job: { id: JOB }, currentInterviewStage: { id: AI_STAGE } },
          };
        },
      },
      mappings: { resolveByJobId: async () => ({ status: 'enabled', aiScreeningStageId: AI_STAGE }) },
      receipts: { markStatus: async () => {} },
      enabledMappings: {
        async listEnabled() {
          loaderCalls.n += 1;
          return { rows: [{ externalJobId: JOB, aiScreeningStageId: AI_STAGE }], truncated: false };
        },
      },
      queue: { enqueue: async () => {} },
      runtimeConfig: {},
    } as unknown as Parameters<typeof buildAshbyHandlers>[0];
  }

  function signalJob(stageId: string) {
    return {
      id: `job_${stageId}`,
      name: ASHBY_SIGNAL_QUEUE,
      payload: payloadFor(stageId),
      attempts: 1,
      leaseToken: 't',
    } as unknown as Parameters<ReturnType<typeof buildAshbyHandlers>[string]>[0];
  }

  it('is OFF by default — the skip is opt-in', async () => {
    // The safety argument rests on an unverified assumption about the tenant's
    // webhook payload shape. Default-off means one release of observation
    // before the skip is trusted, and `ASHBY_STAGE_PREFILTER_ENABLED` makes
    // unwiring it a runtime action rather than a deploy.
    const reads = { n: 0 };
    const handlers = buildAshbyHandlers(stubRuntime(reads, { n: 0 }));
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(UNMAPPED_STAGE));
    expect(reads.n).toBe(1);   // authoritative read still happens
  });

  it('spends no provider read on an unmapped stage once ENABLED, reading the set ONCE', async () => {
    const reads = { n: 0 };
    const loaderCalls = { n: 0 };
    const handlers = buildAshbyHandlers(
      stubRuntime(reads, loaderCalls),
      { stagePrefilterEnabled: true },
    );
    const handler = handlers[ASHBY_SIGNAL_QUEUE]!;

    await handler(signalJob(UNMAPPED_STAGE));
    await handler(signalJob(UNMAPPED_STAGE));

    // Wired: the storm costs nothing at the provider.
    expect(reads.n).toBe(0);
    // Built once: a per-job filter would re-read the mapping set every time.
    expect(loaderCalls.n).toBe(1);
  });

  it('still does the authoritative read for a mapped stage when enabled', async () => {
    const reads = { n: 0 };
    const loaderCalls = { n: 0 };
    const handlers = buildAshbyHandlers(
      stubRuntime(reads, loaderCalls),
      { stagePrefilterEnabled: true },
    );
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(AI_STAGE));
    expect(reads.n).toBe(1);
  });

  it('registers all three Ashby queues, signal first — the starvation precondition', async () => {
    const handlers = buildAshbyHandlers(stubRuntime({ n: 0 }, { n: 0 }));
    // Documents WHY the runner fairness fix in this same change is required:
    // the storm queue is first in iteration order.
    expect(Object.keys(handlers)[0]).toBe(ASHBY_SIGNAL_QUEUE);
    expect(Object.keys(handlers)).toContain(ASHBY_INGESTION_QUEUE);
  });
});

describe('createStageInterestFilter — fail-open is the whole contract', () => {
  const mapped: EnabledMappingRow[] = [
    { externalJobId: JOB, aiScreeningStageId: AI_STAGE },
  ];

  it('answers false ONLY from a complete, non-empty set that lacks the stage', async () => {
    const l = loader(mapped);
    const filter = createStageInterestFilter({ mappings: l.loader });
    expect(await filter(UNMAPPED_STAGE)).toBe(false);
    expect(await filter(AI_STAGE)).toBe(true);
  });

  it('fails open on a TRUNCATED read and never answers from the partial view', async () => {
    // The missing stage may simply be in the unread remainder, so a truncated
    // read must never be cached or answered from. It is also a PERSISTENT
    // condition (more mappings than the bound), so it backs off rather than
    // re-querying on every signal — the amplification that would otherwise bite
    // hardest during the very storm this filter exists to absorb.
    const l = loader(mapped, { truncated: true });
    let now = 0;
    const filter = createStageInterestFilter({
      mappings: l.loader, nowMs: () => now, failureBackoffMs: 5_000,
    });
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    expect(await filter(AI_STAGE)).toBe(true);
    expect(l.calls).toBe(1);
    // It does retry once the backoff lapses — never a permanent give-up.
    now += 5_001;
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    expect(l.calls).toBe(2);
  });

  it('fails open on an EMPTY read rather than declaring every stage uninteresting', async () => {
    const l = loader([]);
    const filter = createStageInterestFilter({ mappings: l.loader });
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    expect(l.calls).toBe(1);
  });

  it('fails open when the read throws, and recovers once it succeeds', async () => {
    let fail = true;
    const calls = { n: 0 };
    const mappings: EnabledMappingLoader = {
      async listEnabled() {
        calls.n += 1;
        if (fail) throw new Error('transient');
        return { rows: mapped, truncated: false };
      },
    };
    let now = 0;
    const filter = createStageInterestFilter({
      mappings, nowMs: () => now, failureBackoffMs: 5_000,
    });
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    fail = false;
    // Inside the backoff the failure is still remembered — fail open, no query.
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    expect(calls.n).toBe(1);
    // Past it, the filter recovers fully and starts answering again.
    now += 5_001;
    expect(await filter(UNMAPPED_STAGE)).toBe(false);
    expect(calls.n).toBe(2);
  });

  it('caches within the TTL and re-reads after it', async () => {
    const l = loader(mapped);
    let now = 1_000;
    const filter = createStageInterestFilter({
      mappings: l.loader, nowMs: () => now, cacheMs: 60_000,
    });
    await filter(UNMAPPED_STAGE);
    await filter(UNMAPPED_STAGE);
    await filter(AI_STAGE);
    expect(l.calls).toBe(1);

    now += 60_001;
    await filter(UNMAPPED_STAGE);
    expect(l.calls).toBe(2);
  });

  it('single-flights a burst so a storm cannot stampede the read', async () => {
    const l = loader(mapped);
    const filter = createStageInterestFilter({ mappings: l.loader });
    const answers = await Promise.all(
      Array.from({ length: 25 }, () => filter(UNMAPPED_STAGE)),
    );
    expect(answers.every((a) => a === false)).toBe(true);
    expect(l.calls).toBe(1);
  });

  it('passes a real numeric bound to the port, matching reconciliation', async () => {
    // A bound BELOW reconciliation's would report `truncated` on every read for
    // a tenant reconciliation handles fine — permanent fail-open, permanently
    // uncached, i.e. one EXTRA query per signal. A pure regression.
    const l = loader(mapped);
    const filter = createStageInterestFilter({ mappings: l.loader });
    await filter(AI_STAGE);
    expect(l.limits).toEqual([DEFAULT_MAX_ENABLED_MAPPINGS]);
    expect(STAGE_INTEREST_MAX_MAPPINGS).toBe(DEFAULT_MAX_ENABLED_MAPPINGS);
  });

  it('uses a real default TTL, not a zero that would re-read every signal', async () => {
    expect(STAGE_INTEREST_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    // Exercise the DEFAULT, not an explicitly-passed cacheMs.
    const l = loader(mapped);
    let now = 0;
    const filter = createStageInterestFilter({ mappings: l.loader, nowMs: () => now });
    await filter(AI_STAGE);
    now += STAGE_INTEREST_CACHE_MS - 1;
    await filter(AI_STAGE);
    expect(l.calls).toBe(1);            // still inside the default TTL
    now += 2;
    await filter(AI_STAGE);
    expect(l.calls).toBe(2);            // and it does expire
  });

  it('fails open on a malformed loader response with no rows', async () => {
    const mappings = {
      async listEnabled() { return { truncated: false } as unknown as { rows: EnabledMappingRow[]; truncated: boolean }; },
    };
    const filter = createStageInterestFilter({ mappings });
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
  });

  it('fails OPEN when EVERY mapping row has a NULL stage id', async () => {
    // THE dangerous state, and the one a mixed-row test cannot reach: without
    // the string guard the set becomes Set{null} — size 1, so the "empty means
    // indeterminate" bail never fires — and the filter then answers `false` for
    // EVERY stage on the tenant. Every signal skipped, every candidate
    // unscreened, with only an info log per event to show for it.
    //
    // A mixed set (one good row + NULLs) is NOT a test of this: Set{null,'',X}
    // answers identically to Set{X} for every real string stage id, so the
    // guard can be deleted with such a test still green.
    const rows = [
      { externalJobId: 'j1', aiScreeningStageId: null },
      { externalJobId: 'j2', aiScreeningStageId: '' },
    ] as unknown as EnabledMappingRow[];
    const filter = createStageInterestFilter({
      mappings: { async listEnabled() { return { rows, truncated: false }; } },
    });
    expect(await filter(AI_STAGE)).toBe(true);
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
  });

  it('drops NULL rows but still answers from the real ones', async () => {
    const rows = [
      { externalJobId: 'j1', aiScreeningStageId: null },
      { externalJobId: 'j3', aiScreeningStageId: AI_STAGE },
    ] as unknown as EnabledMappingRow[];
    const filter = createStageInterestFilter({
      mappings: { async listEnabled() { return { rows, truncated: false }; } },
    });
    expect(await filter(AI_STAGE)).toBe(true);
    expect(await filter(UNMAPPED_STAGE)).toBe(false);
  });

  it('pins both new defaults, which are silently load-bearing', async () => {
    // A zero timeout is the nastiest mutation available here: in tests the stub
    // resolves on a MICROTASK and always beats a 0ms macrotask timer, so every
    // test stays green — while in production `listEnabled` is a real DB
    // round-trip (a macrotask) that the timer wins ~always, permanently
    // disabling the filter with nothing logged.
    expect(STAGE_INTEREST_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    // Zero backoff restores the per-signal amplification it exists to prevent;
    // a very large one disables the filter for minutes after one blip.
    expect(STAGE_INTEREST_FAILURE_BACKOFF_MS).toBeGreaterThanOrEqual(1_000);
    expect(STAGE_INTEREST_FAILURE_BACKOFF_MS).toBeLessThan(STAGE_INTEREST_CACHE_MS);
  });

  it('bounds a stalled MACROTASK read, not just a never-settling promise', async () => {
    // Uses a real timer so the race is macrotask-vs-macrotask, the shape
    // production actually has.
    const mappings: EnabledMappingLoader = {
      listEnabled: () => new Promise((resolve) => {
        setTimeout(() => resolve({ rows: mapped, truncated: false }), 200);
      }),
    };
    const filter = createStageInterestFilter({ mappings, timeoutMs: 10 });
    expect(await filter(UNMAPPED_STAGE)).toBe(true);   // timed out → fail open
  });

  it('stamps the cache at read START, so a slow read cannot extend its own trust', async () => {
    let now = 0;
    const calls = { n: 0 };
    const mappings: EnabledMappingLoader = {
      async listEnabled() {
        calls.n += 1;
        now += 30_000;          // the read itself takes 30s of clock
        return { rows: mapped, truncated: false };
      },
    };
    const filter = createStageInterestFilter({
      mappings, nowMs: () => now, cacheMs: 60_000, timeoutMs: 120_000,
    });
    await filter(AI_STAGE);                 // started at 0, resolved at 30_000
    now = 59_000;                           // 59s after the read STARTED
    await filter(AI_STAGE);
    expect(calls.n).toBe(1);                // still cached
    now = 60_001;                           // 60s after start → expired
    await filter(AI_STAGE);
    expect(calls.n).toBe(2);
    // Stamping at resolution would have kept it cached until 90_000.
  });

  it('bounds a stalled read instead of parking a concurrency slot on it', async () => {
    // Unbounded, this sits at the HEAD of the signal handler while the runner
    // heartbeat renews the lease — no reclaim, no DLQ, no event.
    const mappings: EnabledMappingLoader = {
      listEnabled: () => new Promise(() => { /* never settles */ }),
    };
    const filter = createStageInterestFilter({ mappings, timeoutMs: 5 });
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
  });

  it('backs off after a failure instead of re-querying on every signal', async () => {
    let calls = 0;
    const mappings: EnabledMappingLoader = {
      async listEnabled() { calls += 1; throw new Error('db_down'); },
    };
    let now = 0;
    const filter = createStageInterestFilter({
      mappings, nowMs: () => now, failureBackoffMs: 5_000,
    });
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    expect(calls).toBe(1);              // amplification suppressed
    now += 5_001;
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
    expect(calls).toBe(2);              // and it does retry
  });

  it('starts admitting a stage once its mapping is enabled', async () => {
    // The conditional verdict is only safe because the filter notices the
    // change; a permanently stale set would recreate the B2 blindness.
    let rows: EnabledMappingRow[] = mapped;
    let now = 0;
    const mappings: EnabledMappingLoader = {
      async listEnabled() { return { rows, truncated: false }; },
    };
    const filter = createStageInterestFilter({
      mappings, nowMs: () => now, cacheMs: 60_000,
    });
    expect(await filter(UNMAPPED_STAGE)).toBe(false);

    rows = [...mapped, { externalJobId: 'job_2', aiScreeningStageId: UNMAPPED_STAGE }];
    now += 60_001;
    expect(await filter(UNMAPPED_STAGE)).toBe(true);
  });
});
