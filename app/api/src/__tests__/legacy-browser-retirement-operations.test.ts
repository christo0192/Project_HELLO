/**
 * PR-L review finding (P3): the Ashby invite_delivery operation worker.
 *
 * `runImport` withholds the browser invite operation once the legacy lane is
 * retired, but an operation enqueued BEFORE the retirement (or deferred across it
 * on ingestion_not_ready / mapping_inactive) is still claimed afterwards.
 * `materializeInvite` would then insert a call_sessions row (mode 'browser',
 * status 'created') and a 24 h candidate_invites row for a lane that answers 410,
 * so the drain's "created since T0" count never reaches zero.
 *
 * Retired, the worker therefore fails such an operation terminally with
 * `browser_screening_retired`, creates nothing, never defers it and logs the same
 * `ashby_legacy_browser_invite_skipped` marker as the import path. Enabled, the
 * path is exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedLoop {
  name: string;
  intervalMs: number;
  tick: () => Promise<unknown>;
}
let loops: CapturedLoop[] = [];

vi.mock('../integrations/ashby/scheduler.js', () => ({
  createAshbyScheduler: (options: { loops: CapturedLoop[] }) => {
    loops = options.loops;
    return { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), snapshot: vi.fn() };
  },
  queueRunnerTick: (runner: { tick: () => Promise<unknown> }) => async () => {
    await runner.tick();
    return false;
  },
}));

vi.mock('../lib/queue/runner.js', () => ({
  createQueueRunner: () => ({
    tick: vi.fn().mockResolvedValue({ processed: 0 }),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  queueRunnerTick: (runner: { tick: () => Promise<unknown> }) => async () => {
    await runner.tick();
    return false;
  },
}));

import {
  LEGACY_INVITE_SKIPPED_EVENT,
  runClaimedAshbyOperation,
} from '../integrations/ashby/operation-worker.js';
import { createAshbyWorkers } from '../integrations/ashby/runtime-workers.js';
import type {
  OperationClaimRow,
  RuntimeWorkflowStores,
  WorkflowLinkRow,
} from '../integrations/ashby/orchestration.js';
import type {
  MaterializationMapping,
  MaterializationStore,
} from '../integrations/ashby/materialize.js';

const ENV_KEY = 'LEGACY_BROWSER_SCREENING_ENABLED';
const ORIGINAL_FLAG = process.env[ENV_KEY];

const LINK = 'link_1';
const APP = 'app_1';
const ROLE = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const RETIRED = 'browser_screening_retired';

const claim: OperationClaimRow = {
  id: 'op_1',
  operationType: 'invite_delivery',
  operationKey: `ashby:invite:${APP}:manual:pending`,
  applicationLinkId: LINK,
  leaseToken: 'lease-abc',
  attempts: 1,
  maxAttempts: 5,
  marker: null,
};

const link: WorkflowLinkRow = {
  id: LINK,
  externalApplicationId: APP,
  externalJobId: 'job_1',
  jobMappingId: 'map_1',
  externalResumeFileHandle: 'handle_1',
  candidateId: 'cand_1',
  sessionId: null,
  inviteId: null,
  lifecycle: 'processing',
  terminalState: null,
};

const mapping: MaterializationMapping = {
  id: 'map_1',
  roleId: ROLE,
  ownerId: OWNER,
  deliveryMode: 'manual',
};

/** A materialization store whose every write is a spy. */
function materialization() {
  const store = {
    insertResume: vi.fn(async () => ({ id: 'r1' })),
    insertCandidate: vi.fn(async () => ({ id: 'c1' })),
    bindLinkColumn: vi.fn(async (input: { value: string }) => ({
      bound: input.value,
      wonRace: true,
    })),
    deleteOrphan: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({ id: 'session-new' })),
    findActiveInvite: vi.fn(async () => null),
    insertInvite: vi.fn(async () => ({ id: 'invite-new' })),
  };
  return store as typeof store & MaterializationStore;
}

function stores(over: Partial<RuntimeWorkflowStores> = {}) {
  const spies = {
    completeOperation: vi.fn(async () => 'ok' as const),
    failOperation: vi.fn(async () => 'ok' as const),
    deferOperation: vi.fn(async () => 'ok' as const),
    parkOperationAwaitingDelivery: vi.fn(async () => 'ok' as const),
  };
  const all = {
    findLinkByApplicationId: async () => null,
    createLink: async () => ({ id: LINK }),
    advanceIngestion: async () => ({ status: 'ok' }),
    enqueueOperation: async () => ({ status: 'inserted', id: 'op' }),
    claimOperation: async (type: string | null) => (type === 'invite_delivery' ? claim : null),
    readIngestion: async () => ({ state: 'ready', attempts: 0 }),
    readLink: async () => link,
    markWritebackPending: async () => ({ status: 'ok' }),
    ...spies,
    ...over,
  };
  return { stores: all as unknown as RuntimeWorkflowStores, spies };
}

function workerDeps(
  rs: RuntimeWorkflowStores,
  store: MaterializationStore,
  over: Record<string, unknown> = {},
) {
  return {
    stores: rs,
    materialization: store,
    resolveMappingForLink: vi.fn(async () => mapping as MaterializationMapping | null),
    reissuePathFor: (id: string) => `/ashby-mission-control?application=${id}`,
    email: { providerApproved: false, domainVerified: false },
    owner: 'w1',
    leaseSeconds: 30,
    nowMs: () => Date.parse('2026-10-06T00:00:00.000Z'),
    ...over,
  };
}

/** Nothing the retired lane could have created or advanced. */
function expectNothingMaterialized(
  store: ReturnType<typeof materialization>,
  spies: ReturnType<typeof stores>['spies'],
): void {
  expect(store.createSession).not.toHaveBeenCalled();
  expect(store.insertInvite).not.toHaveBeenCalled();
  expect(store.findActiveInvite).not.toHaveBeenCalled();
  expect(store.bindLinkColumn).not.toHaveBeenCalled();
  expect(spies.parkOperationAwaitingDelivery).not.toHaveBeenCalled();
  expect(spies.completeOperation).not.toHaveBeenCalled();
}

beforeEach(() => {
  loops = [];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_FLAG;
});

describe('runClaimedAshbyOperation with the legacy browser lane retired', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'false';
  });

  it('terminally fails a pre-queued invite_delivery and creates no session or invite', async () => {
    const { stores: rs, spies } = stores();
    const store = materialization();
    const result = await runClaimedAshbyOperation(workerDeps(rs, store));

    expect(result).toEqual({
      claimed: true,
      operationType: 'invite_delivery',
      committed: false,
      staleLease: false,
      code: RETIRED,
    });
    expect(spies.failOperation).toHaveBeenCalledTimes(1);
    // Non-retryable: no retry can bring the lane back.
    expect(spies.failOperation).toHaveBeenCalledWith('op_1', 'lease-abc', RETIRED, false);
    expectNothingMaterialized(store, spies);
  });

  it('does the same for an email-channel operation', async () => {
    const { stores: rs, spies } = stores({
      claimOperation: async () => ({
        ...claim,
        operationKey: `ashby:invite:${APP}:email:pending`,
      }),
    });
    const store = materialization();
    const result = await runClaimedAshbyOperation(workerDeps(rs, store));
    expect(result).toMatchObject({ claimed: true, committed: false, code: RETIRED });
    expectNothingMaterialized(store, spies);
  });

  it('fails it instead of deferring when the ingestion is not ready', async () => {
    const { stores: rs, spies } = stores({
      readIngestion: async () => ({ state: 'fetching', attempts: 1 }),
    });
    const store = materialization();
    const result = await runClaimedAshbyOperation(workerDeps(rs, store));
    expect(result).toMatchObject({ code: RETIRED, committed: false });
    expect(spies.deferOperation).not.toHaveBeenCalled();
    expectNothingMaterialized(store, spies);
  });

  it('fails it instead of deferring forever when the mapping is paused', async () => {
    const { stores: rs, spies } = stores();
    const store = materialization();
    const deps = workerDeps(rs, store, { resolveMappingForLink: vi.fn(async () => null) });
    const result = await runClaimedAshbyOperation(deps);
    expect(result).toMatchObject({ code: RETIRED, committed: false });
    // Checked before the mapping lookup, so a pause cannot keep it deferring.
    expect(deps.resolveMappingForLink).not.toHaveBeenCalled();
    expect(spies.deferOperation).not.toHaveBeenCalled();
    expectNothingMaterialized(store, spies);
  });

  it('reports a lost lease as stale, committing nothing', async () => {
    const { stores: rs, spies } = stores({ failOperation: async () => 'not_owned' as never });
    const store = materialization();
    const result = await runClaimedAshbyOperation(workerDeps(rs, store));
    expect(result).toMatchObject({ claimed: true, committed: false, staleLease: true });
    expectNothingMaterialized(store, spies);
  });

  it('emits the skip event with metadata only', async () => {
    const { stores: rs } = stores();
    const onEvent = vi.fn();
    await runClaimedAshbyOperation(workerDeps(rs, materialization(), { onEvent }));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      kind: LEGACY_INVITE_SKIPPED_EVENT,
      operationType: 'invite_delivery',
      code: RETIRED,
    });
  });

  it('fails closed for a malformed flag value', async () => {
    process.env[ENV_KEY] = 'definitely';
    const { stores: rs, spies } = stores();
    const store = materialization();
    const result = await runClaimedAshbyOperation(workerDeps(rs, store));
    expect(result).toMatchObject({ code: RETIRED, committed: false });
    expectNothingMaterialized(store, spies);
  });

  it('keeps the terminal-application check first (blocked_terminal, not retired)', async () => {
    const { stores: rs, spies } = stores({
      readLink: async () => ({ ...link, terminalState: 'withdrawn' }),
    });
    const result = await runClaimedAshbyOperation(workerDeps(rs, materialization()));
    expect(result).toMatchObject({ code: 'blocked_terminal' });
    expect(spies.failOperation).toHaveBeenCalledWith('op_1', 'lease-abc', 'terminal_cancel', false);
  });

  it('does not touch the scorecard_write lane', async () => {
    const { stores: rs, spies } = stores({
      claimOperation: async () => ({ ...claim, operationType: 'scorecard_write' }),
    });
    const result = await runClaimedAshbyOperation(workerDeps(rs, materialization()));
    // No scorecard sink is configured, so the lane's own refusal answers.
    expect(result).toMatchObject({ code: 'scorecard_sink_unavailable' });
    expect(spies.failOperation).toHaveBeenCalledWith(
      'op_1', 'lease-abc', 'scorecard_sink_unavailable', false,
    );
  });
});

describe('runClaimedAshbyOperation with the legacy browser lane enabled', () => {
  it.each([
    ['unset', undefined],
    ['an explicit "true"', 'true'],
  ])('still materializes and parks the manual invite when the flag is %s', async (_n, flag) => {
    if (flag !== undefined) process.env[ENV_KEY] = flag;
    const { stores: rs, spies } = stores();
    const store = materialization();
    const result = await runClaimedAshbyOperation(workerDeps(rs, store));

    expect(result).toMatchObject({
      claimed: true,
      committed: true,
      code: 'awaiting_manual_delivery',
    });
    expect(store.createSession).toHaveBeenCalledTimes(1);
    expect(store.insertInvite).toHaveBeenCalledTimes(1);
    expect(spies.parkOperationAwaitingDelivery).toHaveBeenCalledTimes(1);
    expect(spies.failOperation).not.toHaveBeenCalled();
  });
});

describe('the production operation loop (createAshbyWorkers)', () => {
  let writes: string[];
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes = [];
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(() => {
    stdout.mockRestore();
  });

  function build(rs: RuntimeWorkflowStores, store: MaterializationStore) {
    createAshbyWorkers({
      runtime: {
        runtimeConfig: {
          leaseSeconds: 60,
          signalPollMs: 5000,
          operationPollMs: 7000,
          reconcileIntervalMs: 900_000,
          reclaimIntervalMs: 60_000,
          scannerReadinessTimeoutMs: 1000,
          reconcileCaps: {},
          reconcileAnchorDisabled: false,
        },
        queue: { enqueue: vi.fn(), claim: vi.fn() },
        stores: rs,
        materialization: store,
        client: {},
        resolveMappingForLink: vi.fn(async () => mapping),
        shutdown: vi.fn().mockResolvedValue(undefined),
      } as never,
      owner: 'api-test',
      scheduler: {
        setTimer: (() => 0) as never,
        clearTimer: (() => undefined) as never,
        random: () => 0.5,
        now: () => 0,
      },
    });
    const loop = loops.find((l) => l.name === 'operation');
    expect(loop, 'no `operation` loop was registered').toBeDefined();
    return loop!;
  }

  it('retired: fails the pre-queued operation, creates nothing, logs the skip marker', async () => {
    process.env[ENV_KEY] = 'false';
    const { stores: rs, spies } = stores();
    const store = materialization();
    const did = await build(rs, store).tick();

    expect(did).toBe(true);
    expect(spies.failOperation).toHaveBeenCalledWith('op_1', 'lease-abc', RETIRED, false);
    expectNothingMaterialized(store, spies);

    const logged = writes.join('');
    expect(logged).toContain('ashby_legacy_browser_invite_skipped');
    expect(logged).toContain(RETIRED);
    // Metadata only: no application id and no lease token.
    expect(logged).not.toContain(APP);
    expect(logged).not.toContain('lease-abc');
  });

  it('enabled: parks the manual invite and logs no skip marker', async () => {
    const { stores: rs, spies } = stores();
    const store = materialization();
    await build(rs, store).tick();

    expect(store.createSession).toHaveBeenCalledTimes(1);
    expect(spies.parkOperationAwaitingDelivery).toHaveBeenCalledTimes(1);
    expect(spies.failOperation).not.toHaveBeenCalled();
    expect(writes.join('')).not.toContain('ashby_legacy_browser_invite_skipped');
  });
});
