/**
 * PR-L: the Ashby side of the legacy browser retirement.
 *
 *  - runImport enqueues NO browser invite_delivery operation once the lane is
 *    retired (log-and-skip), but still links and ingests the application; the
 *    phone_primary path and the enabled default are unchanged.
 *  - The Mission Control manual invite (which mints a legacy browser invite)
 *    answers 410 while retired, after its admin role check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: mocks.from } }));

import {
  runImport,
  type ApplicationReader,
  type ImportDeps,
  type OrchestrationGates,
  type ResolvedMapping,
  type WorkflowStores,
} from '../integrations/ashby/orchestration.js';
import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';
import { buildAshbyHandlers } from '../integrations/ashby/runtime-workers.js';
import { ASHBY_IMPORT_QUEUE } from '../integrations/ashby/signal-worker.js';

const gates: OrchestrationGates = {
  enabled: true,
  email: { providerApproved: false, domainVerified: false },
};
const AI = 'stage_ai';
const appAtAi = {
  application: { id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: AI } },
};

function reader(): ApplicationReader {
  return {
    applicationInfo: (async () => ({
      results: appAtAi,
      moreDataAvailable: false,
    })) as ApplicationReader['applicationInfo'],
  };
}

function mapping(over: Partial<ResolvedMapping> = {}): ResolvedMapping {
  return { id: 'map_1', status: 'enabled', aiScreeningStageId: AI, deliveryMode: 'both', ...over };
}

function fakeStores() {
  const operations: Array<{ type: string; key: string }> = [];
  const ingestion: string[] = [];
  const stores = {
    findLinkByApplicationId: async () => null,
    createLink: async () => ({ id: 'link_1' }),
    advanceIngestion: async (_id: string, state: string) => {
      ingestion.push(state);
      return { status: 'ok' };
    },
    enqueueOperation: async (input: { operationType: string; operationKey: string }) => {
      operations.push({ type: input.operationType, key: input.operationKey });
      return { status: 'inserted', id: `op_${operations.length}` };
    },
  } as unknown as WorkflowStores;
  return { stores, operations, ingestion };
}

function deps(
  stores: WorkflowStores,
  resolved: ResolvedMapping,
  legacyEnabled?: () => boolean,
): ImportDeps {
  return {
    gates,
    client: reader(),
    stores,
    resolveMapping: async () => resolved,
    ...(legacyEnabled ? { legacyBrowserScreeningEnabled: legacyEnabled } : {}),
  };
}

describe('runImport with the legacy browser lane retired', () => {
  it('withholds the browser invite operations but still links and ingests', async () => {
    const { stores, operations, ingestion } = fakeStores();
    const result = await runImport('app_1', deps(stores, mapping(), () => false));
    expect(result).toMatchObject({
      status: 'imported',
      applicationLinkId: 'link_1',
      reused: false,
      legacyInviteSkipped: true,
    });
    expect(operations).toEqual([]);
    expect(ingestion).toEqual(['queued']);
  });

  it.each(['email', 'manual'] as const)('also skips a %s-only mapping', async (deliveryMode) => {
    const { stores, operations } = fakeStores();
    const result = await runImport(
      'app_1',
      deps(stores, mapping({ deliveryMode }), () => false),
    );
    expect(operations).toEqual([]);
    expect(result).toMatchObject({ status: 'imported', legacyInviteSkipped: true });
  });

  it('leaves the phone_primary path exactly as it was (it never enqueued invites)', async () => {
    const { stores, operations } = fakeStores();
    const result = await runImport(
      'app_1',
      deps(stores, mapping({ screeningMode: 'phone_primary' }), () => false),
    );
    expect(operations).toEqual([]);
    expect(result.status).toBe('imported');
    expect(result).not.toHaveProperty('legacyInviteSkipped');
  });
});

describe('runImport with the legacy browser lane enabled', () => {
  it('enqueues both invite operations, with no extra result field (default deps)', async () => {
    const { stores, operations } = fakeStores();
    const result = await runImport('app_1', deps(stores, mapping()));
    expect(operations.map((o) => o.type)).toEqual(['invite_delivery', 'invite_delivery']);
    expect(result).not.toHaveProperty('legacyInviteSkipped');
  });

  it('enqueues both invite operations when the lane reports enabled', async () => {
    const { stores, operations } = fakeStores();
    const result = await runImport('app_1', deps(stores, mapping(), () => true));
    expect(operations).toHaveLength(2);
    expect(result).not.toHaveProperty('legacyInviteSkipped');
  });
});

describe('Ashby Mission Control manual invite', () => {
  const ORIGINAL = process.env.LEGACY_BROWSER_SCREENING_ENABLED;
  const LINK = '40000000-0000-4000-8000-000000000001';
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LEGACY_BROWSER_SCREENING_ENABLED;
    else process.env.LEGACY_BROWSER_SCREENING_ENABLED = ORIGINAL;
    warnSpy.mockRestore();
  });

  function missionControl(role: 'admin' | 'interviewer', reissueManualInvite = vi.fn()) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { authUser: unknown }).authUser = { id: 'actor-1', appRole: role };
      next();
    });
    app.use('/mc', createAshbyMissionControlRouter({ store: { reissueManualInvite } as never }));
    return { app, reissueManualInvite };
  }

  it('answers 410 browser_screening_retired and mints no invite while retired', async () => {
    process.env.LEGACY_BROWSER_SCREENING_ENABLED = 'false';
    const { app, reissueManualInvite } = missionControl('admin');
    const res = await request(app).post(`/mc/workflows/${LINK}/invite`).send({});
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ ok: false, error: 'browser_screening_retired' });
    expect(reissueManualInvite).not.toHaveBeenCalled();
  });

  it('keeps the admin role check first: a non-admin still gets 403', async () => {
    process.env.LEGACY_BROWSER_SCREENING_ENABLED = 'false';
    const { app, reissueManualInvite } = missionControl('interviewer');
    const res = await request(app).post(`/mc/workflows/${LINK}/invite`).send({});
    expect(res.status).toBe(403);
    expect(reissueManualInvite).not.toHaveBeenCalled();
  });

  it('is unchanged while the lane is enabled (reaches the store)', async () => {
    delete process.env.LEGACY_BROWSER_SCREENING_ENABLED;
    const reissue = vi.fn(async () => ({ status: 'not_found' }));
    const { app } = missionControl('admin', reissue);
    const res = await request(app).post(`/mc/workflows/${LINK}/invite`).send({});
    expect(res.status).toBe(404);
    expect(reissue).toHaveBeenCalledOnce();
  });
});

describe('the ashby.import queue job reads the live lane switch', () => {
  const ORIGINAL = process.env.LEGACY_BROWSER_SCREENING_ENABLED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LEGACY_BROWSER_SCREENING_ENABLED;
    else process.env.LEGACY_BROWSER_SCREENING_ENABLED = ORIGINAL;
  });

  function importRuntime() {
    const operations: string[] = [];
    const enqueues: string[] = [];
    const runtime = {
      runtimeConfig: {},
      client: {
        applicationInfo: async () => ({ ok: true as const, status: 200, results: appAtAi }),
        applicationListHistory: async () => ({
          results: [{ stageId: AI, enteredStageAt: '2026-09-26T00:00:00Z', leftStageAt: null }],
          moreDataAvailable: false,
        }),
      },
      resolveMappingByJobId: async () => ({
        id: 'map_1', status: 'enabled', aiScreeningStageId: AI,
        taScreeningStageId: 'stage_ta', deliveryMode: 'manual',
        activationAt: '2026-09-25T00:00:00Z', activationEpoch: 1, configVersion: 1,
      }),
      // No mapping owns the shell, so materializeShell reports `skipped` and the
      // import proceeds to the invite step this test is about.
      resolveMappingForLink: async () => null,
      stores: {
        findLinkByApplicationId: async () => null,
        createLink: async () => ({ id: 'link_1' }),
        advanceIngestion: async () => ({ status: 'ok' }),
        readLink: async () => ({ id: 'link_1', terminalState: null, candidateId: null }),
        enqueueOperation: async (input: { operationType: string }) => {
          operations.push(input.operationType);
          return { status: 'inserted' };
        },
        readIngestion: async () => ({ state: 'queued', attempts: 0 }),
      },
      isExplicitImportAuthorized: async () => false,
      isSnapshotApplicationAuthorized: async () => false,
      queue: {
        enqueue: async (name: string) => {
          enqueues.push(name);
          return { id: 'q1' };
        },
      },
    } as never;
    return { runtime, operations, enqueues };
  }

  const job = () => ({
    id: 'j1', name: ASHBY_IMPORT_QUEUE, payload: { externalApplicationId: 'app_1' },
    attempts: 1, maxAttempts: 5, createdAt: new Date().toISOString(),
  }) as never;

  it('withholds the browser invite when LEGACY_BROWSER_SCREENING_ENABLED=false', async () => {
    process.env.LEGACY_BROWSER_SCREENING_ENABLED = 'false';
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    const { runtime, operations, enqueues } = importRuntime();
    try {
      await buildAshbyHandlers(runtime)[ASHBY_IMPORT_QUEUE]!(job());
    } finally {
      stdout.mockRestore();
    }
    expect(operations).toEqual([]);
    // The application is still ingested: only the retired invite is withheld.
    expect(enqueues).toEqual(['ashby.ingestion']);
    // "Logs and skips": the skip is visible, metadata only (no identifier).
    const logged = writes.join('');
    expect(logged).toContain('ashby_legacy_browser_invite_skipped');
    expect(logged).not.toContain('app_1');
  });

  it('enqueues the manual invite operation when the lane is enabled (default)', async () => {
    delete process.env.LEGACY_BROWSER_SCREENING_ENABLED;
    const { runtime, operations, enqueues } = importRuntime();
    await buildAshbyHandlers(runtime)[ASHBY_IMPORT_QUEUE]!(job());
    expect(operations).toEqual(['invite_delivery']);
    expect(enqueues).toEqual(['ashby.ingestion']);
  });
});
