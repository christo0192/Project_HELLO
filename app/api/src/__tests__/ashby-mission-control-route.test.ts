/**
 * Ashby Mission Control route — authz matrix, validation, and action mapping.
 *
 * Reads require interviewer+; actions require admin; a viewer/candidate/
 * unauthenticated caller fails closed (403). Sanitized projections only; the
 * race-safe audited RPCs are exercised via an injected store.
 */

import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';
import { setAuditSink, getAuditSink, type AuditEntry } from '../lib/audit.js';
import { viewerReadOnly } from '../lib/rbac.js';
import type { MissionControlStore } from '../integrations/ashby/workflow-stores.js';
import { HELLO_CHRISTY_SCORECARD_BINDING } from '../integrations/ashby/scorecard.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const ROLE_UUID = '66666666-6666-4666-8666-666666666666';

function fakeStore(over: Partial<MissionControlStore> = {}): MissionControlStore {
  return {
    listMappings: async () => [
      { id: UUID, externalJobId: 'job_1', status: 'drift', statusReason: 'stage_id_invalid', deliveryMode: 'both', hasAiStage: true, hasTaStage: false, label: null, roleId: ROLE_UUID, updatedAt: '2026-08-13T00:00:00Z' },
    ],
    listWorkflows: async () => [
      { applicationLinkId: UUID, externalApplicationId: 'app_1', externalJobId: 'job_1', lifecycle: 'processing', terminalState: null, ingestionState: 'failed_review', operations: [{ id: 'op_1', type: 'stage_move', state: 'failed', errorCode: 'transient_x' }], sessionStatus: 'in_progress', updatedAt: '2026-08-13T00:00:00Z' },
    ],
    setMappingStatus: async () => ({ status: 'ok', mappingStatus: 'paused' }),
    cancelApplication: async () => ({ status: 'ok', cancelledOperations: 2, cancelledIngestion: 1 }),
    retryOperation: async () => ({ status: 'ok' }),
    retryIngestionParse: async () => ({ status: 'ok' }),
    retryLegacyBadOutput: async () => ({ status: 'ok' }),
    retryModelDegraded: async () => ({ status: 'ok' }),
    archiveMapping: async () => ({ status: 'ok', alreadyArchived: false }),
    upsertMapping: async () => ({ status: 'ok', id: UUID }),
    reissueManualInvite: async () => ({ status: 'ok', inviteId: UUID, revokedInvites: 0 }),
    ...over,
  };
}

function appWith(role: string | null, store: MissionControlStore) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: 'user_1', appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter({ store }));
  return app;
}

describe('reads — interviewer+ only', () => {
  it('lists mappings + workflows for an interviewer (sanitized)', async () => {
    const app = appWith('interviewer', fakeStore());
    const m = await request(app).get('/mc/mappings');
    expect(m.status).toBe(200);
    expect(m.body.mappings[0]).not.toHaveProperty('email');
    expect(m.body.mappings[0].status).toBe('drift');
    // The mapping's role travels with it so the page can name the role.
    expect(m.body.mappings[0].roleId).toBe(ROLE_UUID);
    const w = await request(app).get('/mc/workflows');
    expect(w.status).toBe(200);
    expect(w.body.workflows[0].ingestionState).toBe('failed_review');
    // No token/PII fields leak.
    expect(JSON.stringify(w.body)).not.toMatch(/token|email|phone|bearer/i);
  });

  it('carries the screening session status so a park that did not land is visible', async () => {
    const stranded = fakeStore({
      listWorkflows: async () => [{
        applicationLinkId: UUID, externalApplicationId: 'app_1', externalJobId: 'job_1',
        lifecycle: 'ready', terminalState: null, ingestionState: 'ready', operations: [],
        sessionStatus: 'completed', updatedAt: '2026-08-17T00:00:00Z',
      }],
    });
    const w = await request(appWith('interviewer', stranded)).get('/mc/workflows');
    expect(w.status).toBe(200);
    // Completed screening + non-parked, non-terminal lifecycle = the stranded
    // completion-park case the best-effort observer can produce.
    expect(w.body.workflows[0].sessionStatus).toBe('completed');
    expect(w.body.workflows[0].lifecycle).not.toBe('writeback_pending');
    // Still no PII: a status enum only.
    expect(JSON.stringify(w.body)).not.toMatch(/token|email|phone|bearer/i);
  });

  it('fails closed for a viewer and for an unauthenticated caller', async () => {
    expect((await request(appWith('viewer', fakeStore())).get('/mc/mappings')).status).toBe(403);
    expect((await request(appWith(null, fakeStore())).get('/mc/mappings')).status).toBe(403);
  });
});

describe('actions — admin only', () => {
  it('rejects an interviewer from mutating', async () => {
    expect((await request(appWith('interviewer', fakeStore())).post(`/mc/mappings/${UUID}/pause`)).status).toBe(403);
    expect((await request(appWith('interviewer', fakeStore())).post(`/mc/workflows/${UUID}/cancel`).send({ terminal_state: 'withdrawn' })).status).toBe(403);
  });

  it('admin can pause, resume, cancel, retry', async () => {
    const app = appWith('admin', fakeStore());
    expect((await request(app).post(`/mc/mappings/${UUID}/pause`)).status).toBe(200);
    const cancel = await request(app).post(`/mc/workflows/${UUID}/cancel`).send({ terminal_state: 'withdrawn', reason: 'candidate withdrew' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled_operations).toBe(2);
    expect((await request(app).post(`/mc/operations/${UUID}/retry`)).status).toBe(200);
  });

  it('maps RPC gate statuses to 404/409', async () => {
    const notFound = appWith('admin', fakeStore({ setMappingStatus: async () => ({ status: 'not_found' }) }));
    expect((await request(notFound).post(`/mc/mappings/${UUID}/resume`)).status).toBe(404);
    const incomplete = appWith('admin', fakeStore({ setMappingStatus: async () => ({ status: 'incomplete_cannot_enable' }) }));
    expect((await request(incomplete).post(`/mc/mappings/${UUID}/resume`)).status).toBe(409);
    const alreadyTerminal = appWith('admin', fakeStore({ cancelApplication: async () => ({ status: 'already_terminal' }) }));
    expect((await request(alreadyTerminal).post(`/mc/workflows/${UUID}/cancel`).send({ terminal_state: 'deleted' })).status).toBe(409);
  });

  it('validates ids and terminal_state', async () => {
    const app = appWith('admin', fakeStore());
    expect((await request(app).post('/mc/mappings/not-a-uuid/pause')).status).toBe(400);
    expect((await request(app).post(`/mc/workflows/${UUID}/cancel`).send({ terminal_state: 'bogus' })).status).toBe(400);
  });

  it('previews and separately confirms an exact backlog snapshot', async () => {
    const preview = vi.fn().mockResolvedValue({
      runId: UUID, mappingId: UUID, expectedCount: 2, cap: 500,
      expiresAt: '2099-01-01T00:00:00.000Z', scope: { jobId: 'job_1', stageId: 'stage_ai' },
    });
    const confirm = vi.fn().mockResolvedValue({ status: 'ok', runId: UUID, queuedCount: 1 });
    const app = appWithDeps('admin', { store: fakeStore(), backlogImport: { preview, confirm } as never });
    const p = await request(app).post(`/mc/mappings/${UUID}/backlog/preview`);
    expect(p.status).toBe(200);
    expect(p.body.preview.expectedCount).toBe(2);
    expect(preview).toHaveBeenCalledWith(UUID, UUID);
    const c = await request(app).post(`/mc/mappings/${UUID}/backlog/confirm`)
      .send({ run_id: UUID, expected_count: 2 });
    expect(c.status).toBe(200);
    expect(c.body.queued_count).toBe(1);
    expect(confirm).toHaveBeenCalledWith(UUID, UUID, 2, UUID);
  });

  it('keeps preview/confirmation admin-only and exposes safe conflict states', async () => {
    const preview = vi.fn().mockRejectedValue(new Error('ashby_backlog_cap_exceeded'));
    const confirm = vi.fn().mockResolvedValue({ status: 'count_mismatch' });
    const deps = { store: fakeStore(), backlogImport: { preview, confirm } as never };
    expect((await request(appWithDeps('interviewer', deps)).post(`/mc/mappings/${UUID}/backlog/preview`)).status).toBe(403);
    const app = appWithDeps('admin', deps);
    expect((await request(app).post(`/mc/mappings/${UUID}/backlog/preview`)).status).toBe(409);
    const res = await request(app).post(`/mc/mappings/${UUID}/backlog/confirm`).send({ run_id: UUID, expected_count: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('count_mismatch');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Runtime activation surfaces (health · mapping provisioning · stage probe)
// ═══════════════════════════════════════════════════════════════════════

const SENTINEL_APIKEY = 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaaaaaa';
const SENTINEL_SECRET = 'SENTINEL_SECRET_bbbbbbbbbbbbbbbbbbbb';

/** Fully-on synthetic env; never real credentials. */
function activeEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ASHBY_INTEGRATION_ENABLED: 'true',
    ASHBY_WEBHOOK_SECRET: SENTINEL_SECRET,
    ASHBY_RUNTIME_ENABLED: 'true',
    ASHBY_API_KEY: SENTINEL_APIKEY,
    ASHBY_RESUME_HOSTS: 'files.ashby.example',
    ...over,
  } as NodeJS.ProcessEnv;
}

function emptyBacklog() {
  return {
    queuePending: 0, dlqDepth: 0, oldestPendingAgeSec: null as number | null,
    operationsPending: 0, operationsFailed: 0, operationsAwaitingDelivery: 0,
    operationsBlockedPrerequisite: 0, operationsBlockedFailedIngestion: 0,
    operationsFailedPrerequisite: 0,
    ingestionStuckQueued: 0, ingestionStuckFetching: 0,
    ingestionStuckScanning: 0, ingestionStuckExtracting: 0, ingestionStuckStructuring: 0,
    ingestionFailedParse: 0,
    scannerDeferredJobs: 0, scannerDeferredOldestAgeSec: null,
    writebackPending: 0, reconcileNoProgressRuns: 0, reconcileLastSuccessAt: null,
  };
}

function healthySchedulerSnapshot() {
  return {
    registeredInThisProcess: true,
    running: true,
    loops: [{
      name: 'signal', running: true, lastTickAt: new Date().toISOString(),
      ticks: 12, errors: 0, consecutiveErrors: 0, stale: false,
    }],
  };
}

function appWithDeps(role: string | null, deps: Parameters<typeof createAshbyMissionControlRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: UUID, appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter(deps));
  return app;
}

describe('GET /health — truthful and sanitized', () => {
  it('reports booleans/counts only and leaks no secret material', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
      schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => emptyBacklog(),
    });
    const res = await request(app).get('/mc/health');
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SENTINEL_APIKEY);
    expect(body).not.toContain(SENTINEL_SECRET);
    expect(body).not.toContain('SENTINEL_');
    // The presigned host is tenant-identifying: the COUNT is reported, not the host.
    expect(body).not.toContain('files.ashby.example');
    expect(res.body.runtime.resumeAllowlistCount).toBe(1);
    expect(res.body.runtime.resumeAllowlistEnabled).toBe(true);
    expect(res.body.integration).toEqual({ enabled: true, webhookSecretConfigured: true, active: true });
    expect(res.body.runtime.apiKeyConfigured).toBe(true);
  });

  it('reports all-false with the shipped defaults', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: {} as NodeJS.ProcessEnv,
      schedulerSnapshot: () => ({ registeredInThisProcess: false, running: false, loops: [] }),
      backlog: async () => emptyBacklog(),
    });
    const res = await request(app).get('/mc/health');
    expect(res.body.integration.active).toBe(false);
    expect(res.body.runtime.runtimeEnabled).toBe(false);
    expect(res.body.runtime.apiKeyConfigured).toBe(false);
    expect(res.body.runtime.resumeAllowlistEnabled).toBe(false);
    expect(res.body.runtime.active).toBe(false);
  });

  it('makes no live-connectivity claim it has not verified', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
      schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => emptyBacklog(),
    });
    const res = await request(app).get('/mc/health');
    // Nothing in this handler contacts Ashby, so "ok" would be a lie.
    expect(res.body.provider).toBe('unknown');
  });

  it('is interviewer-gated', async () => {
    const deps = { store: fakeStore(), probeReader: null, configSource: activeEnv() };
    expect((await request(appWithDeps('viewer', deps)).get('/mc/health')).status).toBe(403);
    expect((await request(appWithDeps(null, deps)).get('/mc/health')).status).toBe(403);
  });
});

// ── Reconciliation admission counts (review M-1) ────────────────────────────
//
// The admission counters emitted by runReconciliation go to lib/metrics.ts,
// whose sink is a NO-OP in this deployment. Without a real consumer the
// runbook's re-activation gate — "admitted = 0 and enqueued = 0 while every
// mapping is paused" — could not actually be checked. These tests hold that
// consumer in place.

describe('GET /health — last reconciliation pass', () => {
  const pausedTenantPass = {
    stop: 'drained', mode: 'full',
    observed: 2000, admitted: 0,
    skipped: { noApplicationId: 0, noEnabledMapping: 2000, stageNotAi: 0, ambiguousMapping: 0 },
    unclassified: 0, enabledMappings: 0, mappingIndexTruncated: false,
    recovered: 0, duplicates: 0, enqueued: 0, advanced: true,
    // 0034 continuation surface: booleans and bounded counts only.
    resumed: false, continuationPending: false, pageAnchors: 0,
    resyncPagesDone: 0, resyncItemsDone: 0, restartReason: 'none',
    sweepRestarts: 0, sweepEnqueued: 0, halted: false, tokenInstalled: true,
    observedAt: '2026-08-18T00:00:00.000Z',
  };

  it('surfaces the admission gate an operator must check before enabling a mapping', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
      schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => emptyBacklog(),
      reconcilePass: () => pausedTenantPass,
    });
    const res = await request(app).get('/mc/health');
    expect(res.status).toBe(200);
    // The exact gate from the runbook's re-activation step 6.
    expect(res.body.reconcile.admitted).toBe(0);
    expect(res.body.reconcile.enqueued).toBe(0);
    expect(res.body.reconcile.observed).toBe(2000);
    expect(res.body.reconcile.enabledMappings).toBe(0);
    expect(res.body.reconcile.advanced).toBe(true);
    // observed === admitted + sum(skipped) on a normally-stopped pass.
    const skips = Object.values(res.body.reconcile.skipped as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    expect(res.body.reconcile.admitted + skips).toBe(res.body.reconcile.observed);
  });

  it('reports null when THIS process has run no pass, without claiming none happened', async () => {
    const common = {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
      schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => emptyBacklog(),
    };
    const res = await request(appWithDeps('interviewer', { ...common, reconcilePass: () => null }))
      .get('/mc/health');
    expect(res.status).toBe(200);
    expect(res.body.reconcile).toBeNull();

    // A null pass means "this process has run none" — it is NOT a fleet-wide
    // claim and must not itself move the verdict. The durable backlog and the
    // scheduler heartbeat remain the liveness signals, so the status is
    // identical with and without a published pass.
    const withPass = await request(
      appWithDeps('interviewer', { ...common, reconcilePass: () => pausedTenantPass }),
    ).get('/mc/health');
    expect(res.body.status).toBe(withPass.body.status);
    expect(res.body.reasons).toEqual(withPass.body.reasons);
  });

  it('distinguishes an enqueue_cap pass (real progress) from a stuck stream', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
      schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => emptyBacklog(),
      reconcilePass: () => ({
        ...pausedTenantPass,
        stop: 'enqueue_cap', admitted: 200, enqueued: 200, advanced: false,
        enabledMappings: 1,
        skipped: { noApplicationId: 0, noEnabledMapping: 1800, stageNotAi: 0, ambiguousMapping: 0 },
      }),
    });
    const res = await request(app).get('/mc/health');
    // The discriminator the runbook documents: enqueued > 0 with advanced
    // false is a draining backlog, NOT the re-storming stuck case.
    expect(res.body.reconcile.stop).toBe('enqueue_cap');
    expect(res.body.reconcile.enqueued).toBeGreaterThan(0);
    expect(res.body.reconcile.advanced).toBe(false);
  });

  it('reports a multi-run full resync as progressing, not stuck', async () => {
    // The exact production shape Lane A exists for: a >5,000 corpus whose
    // full resync stops on `page_cap` every run. Pre-0034 that was
    // indistinguishable from a permanently stuck stream; the continuation
    // fields are what make it readable as forward progress.
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
      schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => emptyBacklog(),
      reconcilePass: () => ({
        ...pausedTenantPass,
        stop: 'page_cap', advanced: false,
        resumed: true, continuationPending: true, pageAnchors: 50,
        resyncPagesDone: 100, resyncItemsDone: 10_000,
      }),
    });
    const res = await request(app).get('/mc/health');
    expect(res.body.reconcile.advanced).toBe(false);
    expect(res.body.reconcile.resumed).toBe(true);
    expect(res.body.reconcile.continuationPending).toBe(true);
    expect(res.body.reconcile.resyncItemsDone).toBe(10_000);
    // Still no opaque VALUE anywhere on the surface. The continuation is
    // reported as booleans, bounded counts, and short sanitized codes only —
    // the page cursor and the sync token never leave the service-role
    // boundary, so every string here must be a short lowercase code.
    for (const [key, value] of Object.entries(res.body.reconcile)) {
      if (key === 'observedAt') continue;                 // ISO timestamp
      if (typeof value === 'string') {
        expect(value).toMatch(/^[a-z_]{1,32}$/);
      } else {
        expect(['boolean', 'number', 'object']).toContain(typeof value);
      }
    }
  });

  it('leaks no identifier through the reconciliation surface', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
      schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => emptyBacklog(),
      reconcilePass: () => pausedTenantPass,
    });
    const res = await request(app).get('/mc/health');
    const serialized = JSON.stringify(res.body.reconcile);
    // Counts and sanitized codes only — no opaque provider id shape at all.
    expect(serialized).not.toMatch(/app_|job_|stage_|cand_/);
    expect(Object.keys(res.body.reconcile).sort()).toEqual([
      'admitted', 'advanced', 'continuationPending', 'duplicates',
      'enabledMappings', 'enqueued', 'halted', 'mappingIndexTruncated', 'mode',
      'observed', 'observedAt', 'pageAnchors', 'recovered', 'restartReason',
      'resumed', 'resyncItemsDone', 'resyncPagesDone', 'skipped', 'stop',
      'sweepEnqueued', 'sweepRestarts', 'tokenInstalled', 'unclassified',
    ]);
  });
});

describe('GET /health — real liveness, not configuration', () => {
  /** A ClamAV scanner with current signatures — the only ready state. */
  const readyScanner = async () => ({
    mode: 'clamav' as const, ready: true, signatureAgeSec: 600, maxAgeSec: 86_400, reason: null,
  });
  const base = {
    store: fakeStore(), probeReader: null, configSource: activeEnv(), scanner: readyScanner,
  };

  it('reports healthy when the scheduler is ticking and the backlog is clear', async () => {
    const res = await request(appWithDeps('interviewer', {
      ...base, schedulerSnapshot: healthySchedulerSnapshot, backlog: async () => emptyBacklog(),
    })).get('/mc/health');
    expect(res.body.status).toBe('healthy');
    expect(res.body.reasons).toEqual([]);
    expect(res.body.scheduler.registeredInThisProcess).toBe(true);
    expect(res.body.backlog.queuePending).toBe(0);
  });

  it('degrades when a scheduler loop has gone stale — config-active is NOT worker-live', async () => {
    const res = await request(appWithDeps('interviewer', {
      ...base,
      schedulerSnapshot: () => ({
        registeredInThisProcess: true, running: true,
        loops: [{ name: 'signal', running: true, lastTickAt: '2020-01-01T00:00:00.000Z', ticks: 5, errors: 0, consecutiveErrors: 0, stale: true }],
      }),
      backlog: async () => emptyBacklog(),
    })).get('/mc/health');
    // The integration is configured active, yet health must NOT claim healthy.
    expect(res.body.runtime.active).toBe(true);
    expect(res.body.status).toBe('degraded');
    expect(res.body.reasons).toContain('scheduler_loop_stale');
  });

  it('degrades on a non-empty DLQ, a non-draining queue, and stalled reconciliation', async () => {
    const cases: Array<[Partial<ReturnType<typeof emptyBacklog>>, string]> = [
      [{ dlqDepth: 1 }, 'dlq_non_empty'],
      [{ oldestPendingAgeSec: 100_000 }, 'queue_not_draining'],
      [{ reconcileNoProgressRuns: 5 }, 'reconciliation_not_advancing'],
    ];
    for (const [over, reason] of cases) {
      const res = await request(appWithDeps('interviewer', {
        ...base, schedulerSnapshot: healthySchedulerSnapshot,
        backlog: async () => ({ ...emptyBacklog(), ...over }),
      })).get('/mc/health');
      expect(res.body.status, reason).toBe('degraded');
      expect(res.body.reasons, reason).toContain(reason);
    }
  });

  it('surfaces the manual-delivery and writeback backlogs', async () => {
    const res = await request(appWithDeps('interviewer', {
      ...base, schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => ({ ...emptyBacklog(), operationsAwaitingDelivery: 3, writebackPending: 7 }),
    })).get('/mc/health');
    expect(res.body.backlog.operationsAwaitingDelivery).toBe(3);
    expect(res.body.backlog.writebackPending).toBe(7);
  });

  it('reports idle (not healthy, not broken) when the integration is off', async () => {
    const res = await request(appWithDeps('interviewer', {
      ...base, configSource: {} as NodeJS.ProcessEnv,
      schedulerSnapshot: () => ({ registeredInThisProcess: false, running: false, loops: [] }),
      backlog: async () => emptyBacklog(),
    })).get('/mc/health');
    expect(res.body.status).toBe('idle');
  });

  it('surfaces truthful malware-scanner readiness', async () => {
    const res = await request(appWithDeps('interviewer', {
      ...base, schedulerSnapshot: healthySchedulerSnapshot, backlog: async () => emptyBacklog(),
    })).get('/mc/health');
    expect(res.body.scanner).toEqual({
      mode: 'clamav', ready: true, signatureAgeSec: 600, maxAgeSec: 86400, reason: null,
    });
  });

  it('degrades when the resume scanner cannot screen, and says why', async () => {
    // The production blocker: clamscan installed and exiting 0, on signatures
    // that stopped updating. Health must not report that as healthy.
    const res = await request(appWithDeps('interviewer', {
      ...base, schedulerSnapshot: healthySchedulerSnapshot, backlog: async () => emptyBacklog(),
      scanner: async () => ({
        mode: 'clamav' as const, ready: false, signatureAgeSec: 700_000,
        maxAgeSec: 86_400, reason: 'signatures_stale',
      }),
    })).get('/mc/health');
    expect(res.body.runtime.active).toBe(true);
    expect(res.body.status).toBe('degraded');
    expect(res.body.reasons).toContain('scanner_signatures_stale');
  });

  it('discloses no path, mirror or signature version in the scanner block', async () => {
    const res = await request(appWithDeps('interviewer', {
      ...base, schedulerSnapshot: healthySchedulerSnapshot, backlog: async () => emptyBacklog(),
      scanner: async () => ({
        mode: 'clamav' as const, ready: false, signatureAgeSec: null,
        maxAgeSec: 86_400, reason: 'signatures_missing',
      }),
    })).get('/mc/health');
    const body = JSON.stringify(res.body.scanner);
    for (const forbidden of ['/var', '/etc', 'clamav.net', '.cvd', '.cld', 'clamscan']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('degrades rather than reporting a healthy zero when the backlog read fails', async () => {
    const res = await request(appWithDeps('interviewer', {
      ...base, schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => { throw new Error('db down'); },
    })).get('/mc/health');
    expect(res.body.status).toBe('degraded');
    expect(res.body.reasons).toContain('backlog_unavailable');
    expect(res.body.backlogError).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('db down');
  });

  it('exposes no ids, URLs, secrets or contacts anywhere in the payload', async () => {
    const res = await request(appWithDeps('interviewer', {
      ...base, schedulerSnapshot: healthySchedulerSnapshot,
      backlog: async () => ({ ...emptyBacklog(), operationsAwaitingDelivery: 2 }),
    })).get('/mc/health');
    // Assert on VALUES, not key names: `webhookSecretConfigured` is a legitimate
    // boolean field whose name contains "secret" — it is the value that must
    // never carry a credential, an address, a URL, or a contact.
    const values: unknown[] = [];
    const scan = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) { v.forEach(scan); return; }
      if (typeof v === 'object') { Object.values(v as object).forEach(scan); return; }
      values.push(v);
      // Booleans, bounded integers, timestamps and stable codes only.
      expect(['boolean', 'number', 'string']).toContain(typeof v);
    };
    scan(res.body);
    for (const v of values) {
      if (typeof v !== 'string') continue;
      expect(v, `value must not look like a credential/URL/contact: ${v}`)
        .not.toMatch(/@|https?:\/\/|bearer |[a-f0-9]{32,}/i);
    }
    expect(values.length).toBeGreaterThan(10);
  });
});

describe('POST /mappings — always paused, never enables', () => {
  const valid = {
    external_job_id: 'job_1',
    role_id: UUID,
    delivery_mode: 'manual',
    ai_screening_stage_id: 'stage_ai',
    ta_screening_stage_id: 'stage_ta',
  };

  it('creates a mapping and forces status=paused', async () => {
    const seen: unknown[] = [];
    const store = fakeStore({
      upsertMapping: async (input) => { seen.push(input); return { status: 'ok', id: UUID }; },
    });
    const res = await request(appWithDeps('admin', { store, probeReader: null })).post('/mc/mappings').send(valid);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('paused');
    // The route never forwards a caller-supplied status.
    expect(JSON.stringify(seen)).not.toContain('enabled');
  });

  it('ignores a caller attempt to enable through this surface', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const store = fakeStore({
      upsertMapping: async (input) => { seen.push(input as never); return { status: 'ok', id: UUID }; },
    });
    const res = await request(appWithDeps('admin', { store, probeReader: null }))
      .post('/mc/mappings').send({ ...valid, status: 'enabled' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('paused');
    expect(seen[0]).not.toHaveProperty('status');
  });

  it('is admin-only', async () => {
    const deps = { store: fakeStore(), probeReader: null };
    expect((await request(appWithDeps('interviewer', deps)).post('/mc/mappings').send(valid)).status).toBe(403);
    expect((await request(appWithDeps(null, deps)).post('/mc/mappings').send(valid)).status).toBe(403);
  });

  it('rejects malformed input without touching the store', async () => {
    let called = 0;
    const store = fakeStore({ upsertMapping: async () => { called += 1; return { status: 'ok' }; } });
    const app = appWithDeps('admin', { store, probeReader: null });

    const bad: Array<[string, Record<string, unknown>]> = [
      ['invalid_external_job_id', { ...valid, external_job_id: 'has space' }],
      ['invalid_role_id', { ...valid, role_id: 'not-a-uuid' }],
      ['invalid_delivery_mode', { ...valid, delivery_mode: 'carrier_pigeon' }],
      ['invalid_invite_ttl_hours', { ...valid, invite_ttl_hours: 48 }],
      ['invalid_stage_id', { ...valid, ai_screening_stage_id: 'bad id with spaces' }],
      ['invalid_mapping_id', { ...valid, id: 'nope' }],
      ['invalid_label', { ...valid, label: 'x'.repeat(200) }],
    ];
    for (const [expected, body] of bad) {
      const res = await request(app).post('/mc/mappings').send(body);
      expect(res.status, expected).toBe(400);
      expect(res.body.error, JSON.stringify(body)).toBe(expected);
    }
    expect(called).toBe(0);
  });

  it('accepts the fixed 24-hour TTL when stated explicitly', async () => {
    const store = fakeStore({ upsertMapping: async () => ({ status: 'ok', id: UUID }) });
    const res = await request(appWithDeps('admin', { store, probeReader: null }))
      .post('/mc/mappings').send({ ...valid, invite_ttl_hours: 24 });
    expect(res.status).toBe(201);
  });
});

describe('POST /mappings — create-time Hello Christy stage default (owner decision 2026-09-29)', () => {
  // Pinned as a literal, not imported: a change to the constant must be a
  // deliberate edit here too, never a silent re-point of every new mapping.
  const HELLO_CHRISTY_STAGE = '2358dbcc-394f-45d5-90e4-2bc9af468740';
  const base = { external_job_id: 'job_1', role_id: UUID, delivery_mode: 'manual' };

  function recordingStore() {
    const seen: Array<Record<string, unknown>> = [];
    const store = fakeStore({
      upsertMapping: async (input) => { seen.push(input as never); return { status: 'ok', id: UUID }; },
    });
    return { store, seen };
  }

  it('a new mapping with no stage ids gets the Hello Christy stage as BOTH its AI and TA stage', async () => {
    const { store, seen } = recordingStore();
    const res = await request(appWithDeps('admin', { store, probeReader: null })).post('/mc/mappings').send(base);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('paused');
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBeNull();
    expect(seen[0].aiScreeningStageId).toBe(HELLO_CHRISTY_STAGE);
    expect(seen[0].taScreeningStageId).toBe(HELLO_CHRISTY_STAGE);
  });

  it('treats an empty or null stage id on create as absent', async () => {
    const { store, seen } = recordingStore();
    const app = appWithDeps('admin', { store, probeReader: null });
    await request(app).post('/mc/mappings').send({ ...base, ai_screening_stage_id: '', ta_screening_stage_id: null });
    expect(seen[0].aiScreeningStageId).toBe(HELLO_CHRISTY_STAGE);
    expect(seen[0].taScreeningStageId).toBe(HELLO_CHRISTY_STAGE);
  });

  it('still honours explicit valid stage ids on create, each independently', async () => {
    const { store, seen } = recordingStore();
    const app = appWithDeps('admin', { store, probeReader: null });
    await request(app).post('/mc/mappings').send({ ...base, ai_screening_stage_id: 'stage_ai', ta_screening_stage_id: 'stage_ta' });
    await request(app).post('/mc/mappings').send({ ...base, ai_screening_stage_id: 'stage_ai' });
    expect(seen[0]).toMatchObject({ aiScreeningStageId: 'stage_ai', taScreeningStageId: 'stage_ta' });
    expect(seen[1]).toMatchObject({ aiScreeningStageId: 'stage_ai', taScreeningStageId: HELLO_CHRISTY_STAGE });
  });

  it('never defaults on UPDATE — absent ids pass through as null so the RPC keeps the current stages', async () => {
    const { store, seen } = recordingStore();
    const res = await request(appWithDeps('admin', { store, probeReader: null }))
      .post('/mc/mappings').send({ ...base, id: UUID });
    expect(res.status).toBe(201);
    expect(seen[0].id).toBe(UUID);
    expect(seen[0].aiScreeningStageId).toBeNull();
    expect(seen[0].taScreeningStageId).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(HELLO_CHRISTY_STAGE);
  });

  it('still rejects an invalid stage id rather than defaulting over it', async () => {
    const { store, seen } = recordingStore();
    const app = appWithDeps('admin', { store, probeReader: null });
    for (const body of [
      { ...base, ta_screening_stage_id: 'bad id with spaces' },
      { ...base, ai_screening_stage_id: 42 },
    ]) {
      const res = await request(app).post('/mc/mappings').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_stage_id');
    }
    expect(seen).toHaveLength(0);
  });
});

describe('POST /mappings — create-time Hello Christy feedback-form default', () => {
  // Pinned as a literal, not imported: the scorecard writer (enqueueScorecardWrite)
  // refuses every write unless feedback_form_id is EXACTLY this verified form,
  // so a silent change here must be a deliberate edit of this test too.
  const HELLO_CHRISTY_FORM = '1c9a92c0-c18f-4bf1-898f-c29e71d7d303';
  const base = { external_job_id: 'job_1', role_id: UUID, delivery_mode: 'manual' };

  function recordingStore() {
    const seen: Array<Record<string, unknown>> = [];
    const store = fakeStore({
      upsertMapping: async (input) => { seen.push(input as never); return { status: 'ok', id: UUID }; },
    });
    return { store, seen };
  }

  it('a new mapping that names no form gets the verified Hello Christy form, so its scorecards can be written', async () => {
    expect(HELLO_CHRISTY_SCORECARD_BINDING.verified).toBe(true);
    expect(HELLO_CHRISTY_SCORECARD_BINDING.formDefinitionId).toBe(HELLO_CHRISTY_FORM);
    const { store, seen } = recordingStore();
    const app = appWithDeps('admin', { store, probeReader: null });
    await request(app).post('/mc/mappings').send(base);
    await request(app).post('/mc/mappings').send({ ...base, feedback_form_id: '' });
    await request(app).post('/mc/mappings').send({ ...base, feedback_form_id: null });
    expect(seen).toHaveLength(3);
    for (const input of seen) expect(input.feedbackFormId).toBe(HELLO_CHRISTY_FORM);
  });

  it('honours an explicit valid form id on create', async () => {
    const { store, seen } = recordingStore();
    await request(appWithDeps('admin', { store, probeReader: null }))
      .post('/mc/mappings').send({ ...base, feedback_form_id: 'form_other' });
    expect(seen[0].feedbackFormId).toBe('form_other');
  });

  it('never defaults on UPDATE — an absent form id passes through as null', async () => {
    const { store, seen } = recordingStore();
    const res = await request(appWithDeps('admin', { store, probeReader: null }))
      .post('/mc/mappings').send({ ...base, id: UUID });
    expect(res.status).toBe(201);
    expect(seen[0].feedbackFormId).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(HELLO_CHRISTY_FORM);
  });

  it('does not default while the binding is unverified', async () => {
    const binding = HELLO_CHRISTY_SCORECARD_BINDING as { verified: boolean };
    const { store, seen } = recordingStore();
    binding.verified = false;
    try {
      await request(appWithDeps('admin', { store, probeReader: null })).post('/mc/mappings').send(base);
    } finally {
      binding.verified = true;
    }
    expect(seen[0].feedbackFormId).toBeNull();
  });

  it('rejects an invalid form id rather than defaulting over it', async () => {
    const { store, seen } = recordingStore();
    const res = await request(appWithDeps('admin', { store, probeReader: null }))
      .post('/mc/mappings').send({ ...base, feedback_form_id: 'bad id with spaces' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_stage_id');
    expect(seen).toHaveLength(0);
  });
});

describe('POST /mappings — 0109 refusals surface as 409 with their code', () => {
  const body = { external_job_id: 'job_1', role_id: UUID, delivery_mode: 'manual' };

  it('answers 409 conflict when a create collides with a job that already has a live mapping', async () => {
    // `conflict` is what the store now returns for the unique violation
    // (see the store test in ashby-runtime-adapters.test.ts).
    const upsertMapping = vi.fn(async () => ({ status: 'conflict' }));
    const res = await request(appWithDeps('admin', { store: fakeStore({ upsertMapping }), probeReader: null }))
      .post('/mc/mappings').send(body);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'conflict' });
    expect(upsertMapping).toHaveBeenCalledTimes(1);
  });

  it('answers 409 archived when an update is addressed to a deleted mapping', async () => {
    const upsertMapping = vi.fn(async () => ({ status: 'archived' }));
    const res = await request(appWithDeps('admin', { store: fakeStore({ upsertMapping }), probeReader: null }))
      .post('/mc/mappings').send({ ...body, id: UUID });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'archived' });
  });

  it('audits nothing for a refusal', async () => {
    const entries: AuditEntry[] = [];
    const previous = getAuditSink();
    setAuditSink(async (entry) => { entries.push(entry); });
    try {
      const res = await request(appWithDeps('admin', {
        store: fakeStore({ upsertMapping: async () => ({ status: 'conflict' }) }), probeReader: null,
      })).post('/mc/mappings').send(body);
      expect(res.status).toBe(409);
    } finally {
      setAuditSink(previous);
    }
    expect(entries).toHaveLength(0);
  });
});

describe('GET /jobs — read-only job directory for the Add-mapping picker', () => {
  const DIRECTORY = [
    {
      id: 'job_open',
      title: 'Senior Engineer',
      status: 'Open',
      openedAt: '2026-09-01T10:00:00Z',
      confidential: false,
      hiringTeam: [{ email: 'recruiter@example.invalid', firstName: 'Leaky' }],
      customFields: [{ title: 'Comp band', value: 'secret-comp-band' }],
    },
    { id: 'job_closed', title: 'Analyst', status: 'Closed', openedAt: null, confidential: false },
    { id: 'job_secret', title: 'Replacement for the CFO', status: 'Open', confidential: true },
    // No flag at all: fail-closed, so withheld too.
    { id: 'job_unflagged', title: 'Quiet reorg lead', status: 'Open' },
  ];

  function directoryReader(results: unknown = DIRECTORY) {
    return { jobList: vi.fn(async () => ({ results, moreDataAvailable: false })) };
  }

  it('returns the sanitized directory to an admin — four fields per job, confidential withheld and counted', async () => {
    const jobListReader = directoryReader();
    const res = await request(appWithDeps('admin', { store: fakeStore(), jobListReader: jobListReader as never }))
      .get('/mc/jobs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      jobs: [
        { id: 'job_closed', title: 'Analyst', status: 'Closed', openedAt: null },
        { id: 'job_open', title: 'Senior Engineer', status: 'Open', openedAt: '2026-09-01T10:00:00.000Z' },
      ],
      truncated: false,
      // job_secret (flagged) and job_unflagged (no flag — fail-closed).
      withheld: 2,
    });
    const body = JSON.stringify(res.body);
    for (const leak of ['recruiter@example.invalid', 'Leaky', 'secret-comp-band', 'job_secret', 'Replacement for the CFO', 'job_unflagged', 'Quiet reorg lead']) {
      expect(body, `response must not carry ${leak}`).not.toContain(leak);
    }
    expect(jobListReader.jobList).toHaveBeenCalledTimes(1);
  });

  it('passes a partial walk through as truncated rather than failing', async () => {
    const jobListReader = {
      jobList: vi.fn(async () => ({ results: [{ id: 'job_1', title: 'A', confidential: false }], moreDataAvailable: true, nextCursor: 'loop' })),
    };
    const res = await request(appWithDeps('admin', { store: fakeStore(), jobListReader: jobListReader as never }))
      .get('/mc/jobs');
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.jobs).toHaveLength(1);
  });

  it('is admin-only, and a refused caller never reaches the provider', async () => {
    const jobListReader = directoryReader();
    const deps = { store: fakeStore(), jobListReader: jobListReader as never };
    for (const role of ['interviewer', 'viewer', null]) {
      expect((await request(appWithDeps(role, deps)).get('/mc/jobs')).status, String(role)).toBe(403);
    }
    expect(jobListReader.jobList).not.toHaveBeenCalled();
  });

  it('answers 503 on the `probeReader: null` disabled seam — no client built, no network touched', async () => {
    // Config gates OPEN on purpose: if the null seam did not also close this
    // reader, a real client would be built from this env. The stubbed fetch
    // then proves no request left the process either way.
    const fetchSpy = vi.fn(async () => { throw new Error('network must not be touched'); });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: null, configSource: activeEnv() }))
        .get('/mc/jobs');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'integration_disabled' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers 503 when the reader is explicitly disabled', async () => {
    const res = await request(appWithDeps('admin', { store: fakeStore(), jobListReader: null }))
      .get('/mc/jobs');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('integration_disabled');
  });

  it('reports a provider failure as a sanitized 502 that echoes no provider text', async () => {
    const jobListReader = { jobList: async () => { throw new Error('403 Forbidden: tenant xyz lacks jobsRead'); } };
    const res = await request(appWithDeps('admin', { store: fakeStore(), jobListReader: jobListReader as never }))
      .get('/mc/jobs');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'probe_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('tenant xyz');
  });

  it('audits COUNTS only — never a job id or title', async () => {
    const entries: AuditEntry[] = [];
    const previous = getAuditSink();
    setAuditSink(async (entry) => { entries.push(entry); });
    try {
      const res = await request(appWithDeps('admin', { store: fakeStore(), jobListReader: directoryReader() as never }))
        .get('/mc/jobs');
      expect(res.status).toBe(200);
    } finally {
      setAuditSink(previous);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toEqual({ resource: 'ashby_jobs', count: 2, truncated: false, withheld: 2 });
    const audited = JSON.stringify(entries[0]);
    for (const value of ['job_open', 'job_closed', 'job_secret', 'job_unflagged', 'Senior Engineer', 'Analyst', 'Replacement for the CFO', 'Quiet reorg lead']) {
      expect(audited, `audit must not carry ${value}`).not.toContain(value);
    }
  });

  it('is a GET-only surface — no mutating verb is mounted on the path', async () => {
    const app = appWithDeps('admin', { store: fakeStore(), jobListReader: directoryReader() as never });
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[verb]('/mc/jobs').send({});
      expect(res.status, `${verb} must not be routable`).toBe(404);
    }
  });

  it('does not collide with the job-scoped probes', async () => {
    const jobListReader = directoryReader();
    const probeReader = { jobInterviewPlanInfo: vi.fn(async () => ({ results: { interviewStages: [{ id: 'stage_ai', title: 'AI' }] } })) };
    const app = appWithDeps('admin', { store: fakeStore(), jobListReader: jobListReader as never, probeReader: probeReader as never });

    const directory = await request(app).get('/mc/jobs');
    expect(directory.status).toBe(200);
    expect(directory.body).toHaveProperty('jobs');
    expect(probeReader.jobInterviewPlanInfo).not.toHaveBeenCalled();

    const stages = await request(app).get('/mc/jobs/job_open/stages');
    expect(stages.status).toBe(200);
    expect(stages.body.stages).toEqual([{ id: 'stage_ai', title: 'AI' }]);
    expect(jobListReader.jobList).toHaveBeenCalledTimes(1);
  });
});

describe('GET /jobs — one shared, briefly cached walk (provider-call amplification)', () => {
  const ONE_JOB = [{ id: 'job_1', title: 'Engineer', status: 'Open', confidential: false }];

  /** A fake wall clock the router and the probe both read. */
  function fakeClock(start = 1_700_000_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  function captureAudits() {
    const entries: AuditEntry[] = [];
    const previous = getAuditSink();
    setAuditSink(async (entry) => { entries.push(entry); });
    return { entries, restore: () => setAuditSink(previous) };
  }

  it('serves a request inside the 60 s TTL from the cache — one walk, but one audit row per request', async () => {
    const clock = fakeClock();
    const jobList = vi.fn(async () => ({ results: ONE_JOB, moreDataAvailable: false }));
    const audits = captureAudits();
    try {
      const app = appWithDeps('admin', { store: fakeStore(), jobListReader: { jobList } as never, now: clock.now });
      const first = await request(app).get('/mc/jobs');
      clock.advance(59_999);
      const second = await request(app).get('/mc/jobs');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(jobList).toHaveBeenCalledTimes(1);
    } finally {
      audits.restore();
    }
    const directoryAudits = audits.entries.filter((e) => (e.metadata as Record<string, unknown>)?.resource === 'ashby_jobs');
    expect(directoryAudits).toHaveLength(2);
  });

  it('walks the provider again once the TTL has passed', async () => {
    const clock = fakeClock();
    const jobList = vi.fn()
      .mockResolvedValueOnce({ results: ONE_JOB, moreDataAvailable: false })
      .mockResolvedValueOnce({ results: [...ONE_JOB, { id: 'job_2', title: 'Analyst', confidential: false }], moreDataAvailable: false });
    const app = appWithDeps('admin', { store: fakeStore(), jobListReader: { jobList } as never, now: clock.now });
    const first = await request(app).get('/mc/jobs');
    clock.advance(60_000);
    const second = await request(app).get('/mc/jobs');
    expect(jobList).toHaveBeenCalledTimes(2);
    expect(first.body.jobs).toHaveLength(1);
    expect(second.body.jobs.map((j: { id: string }) => j.id)).toEqual(['job_2', 'job_1']);
  });

  it('never caches a failed walk — the very next request reaches the provider again', async () => {
    const clock = fakeClock();
    const jobList = vi.fn()
      .mockRejectedValueOnce(new Error('503 upstream'))
      .mockResolvedValueOnce({ results: ONE_JOB, moreDataAvailable: false });
    const app = appWithDeps('admin', { store: fakeStore(), jobListReader: { jobList } as never, now: clock.now });
    const failed = await request(app).get('/mc/jobs');
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ ok: false, error: 'probe_unavailable' });
    const retried = await request(app).get('/mc/jobs');
    expect(retried.status).toBe(200);
    expect(retried.body.jobs).toHaveLength(1);
    expect(jobList).toHaveBeenCalledTimes(2);
  });

  /**
   * An app whose outer middleware counts requests AFTER `next()` returns.
   * Express dispatches synchronously, so by then the route handler has run up
   * to its first `await` — i.e. it has either started the walk or joined the
   * one in flight.
   */
  function countingApp(deps: Parameters<typeof createAshbyMissionControlRouter>[0]) {
    const state = { joined: 0 };
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { authUser: unknown }).authUser = { id: UUID, appRole: 'admin' };
      next();
      state.joined += 1;
    });
    app.use('/mc', createAshbyMissionControlRouter(deps));
    return { app, state };
  }

  it('shares ONE in-flight walk between concurrent requests (single-flight)', async () => {
    const clock = fakeClock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobList = vi.fn(async () => { await gate; return { results: ONE_JOB, moreDataAvailable: false }; });
    const { app, state } = countingApp({ store: fakeStore(), jobListReader: { jobList } as never, now: clock.now });

    const all = Promise.all([request(app).get('/mc/jobs'), request(app).get('/mc/jobs'), request(app).get('/mc/jobs')]);
    await vi.waitFor(() => expect(state.joined).toBe(3));
    expect(jobList).toHaveBeenCalledTimes(1);
    release();
    const responses = await all;
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.jobs).toEqual([{ id: 'job_1', title: 'Engineer', status: 'Open', openedAt: null }]);
    }
    expect(jobList).toHaveBeenCalledTimes(1);
  });

  it('hands a failed shared walk to every waiter as 502, then lets the next request start afresh', async () => {
    const clock = fakeClock();
    let fail!: (err: Error) => void;
    const gate = new Promise<never>((_resolve, reject) => { fail = reject; });
    const jobList = vi.fn()
      .mockImplementationOnce(async () => gate)
      .mockResolvedValueOnce({ results: ONE_JOB, moreDataAvailable: false });
    const { app, state } = countingApp({ store: fakeStore(), jobListReader: { jobList } as never, now: clock.now });

    const both = Promise.all([request(app).get('/mc/jobs'), request(app).get('/mc/jobs')]);
    await vi.waitFor(() => expect(state.joined).toBe(2));
    fail(new Error('403 Forbidden: tenant xyz'));
    const [a, b] = await both;
    expect([a.status, b.status]).toEqual([502, 502]);
    expect(JSON.stringify([a.body, b.body])).not.toContain('tenant xyz');
    expect(jobList).toHaveBeenCalledTimes(1);

    const after = await request(app).get('/mc/jobs');
    expect(after.status).toBe(200);
    expect(jobList).toHaveBeenCalledTimes(2);
  });

  it('bounds the whole walk by a ~20 s deadline: partial + truncated once a page is in hand', async () => {
    const clock = fakeClock();
    // Every page takes 8 s of (fake) wall time; the directory never ends.
    let page = 0;
    const jobList = vi.fn(async () => {
      clock.advance(8_000);
      page += 1;
      return { results: [{ id: `job_${page}`, title: `Job ${page}`, confidential: false }], moreDataAvailable: true, nextCursor: `c${page}` };
    });
    const res = await request(appWithDeps('admin', { store: fakeStore(), jobListReader: { jobList } as never, now: clock.now }))
      .get('/mc/jobs');
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    // Pages start at 0 s, 8 s and 16 s; the fourth would start at 24 s.
    expect(jobList).toHaveBeenCalledTimes(3);
    expect(res.body.jobs).toHaveLength(3);
    // Internal — the walk's `timedOut` never reaches the response.
    expect(res.body).not.toHaveProperty('timedOut');
  });

  it('serves a DEADLINE-cut walk but never caches it — the next request walks again', async () => {
    // A slow minute at Ashby is not a property of the directory. Caching the
    // partial list would hide the missing jobs from every admin for 60 s.
    const clock = fakeClock();
    let page = 0;
    const jobList = vi.fn(async () => {
      clock.advance(8_000);
      page += 1;
      return { results: [{ id: `job_${page}`, title: `Job ${page}`, confidential: false }], moreDataAvailable: true, nextCursor: `c${page}` };
    });
    const app = appWithDeps('admin', { store: fakeStore(), jobListReader: { jobList } as never, now: clock.now });
    const first = await request(app).get('/mc/jobs');
    expect(first.body.truncated).toBe(true);
    expect(jobList).toHaveBeenCalledTimes(3);

    clock.advance(1_000); // well inside the 60 s window
    const second = await request(app).get('/mc/jobs');
    expect(second.status).toBe(200);
    expect(jobList).toHaveBeenCalledTimes(6);
  });

  it('answers 502 when the deadline runs out before the first page arrives', async () => {
    const clock = fakeClock();
    const jobList = vi.fn(async () => {
      clock.advance(21_000);
      throw Object.assign(new Error('ashby_timeout'), { code: 'deadline_exceeded' });
    });
    const res = await request(appWithDeps('admin', { store: fakeStore(), jobListReader: { jobList } as never, now: clock.now }))
      .get('/mc/jobs');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'probe_unavailable' });
  });
});

describe('GET /jobs/:externalJobId/stages — read-only probe', () => {
  it('returns sanitized stages for an admin', async () => {
    const probeReader = {
      jobInterviewPlanInfo: async () => ({
        results: { interviewStages: [{ id: 'stage_ai', title: 'Bot Screening', candidateEmail: 'leak@example.invalid' }] },
      }),
    };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/stages');
    expect(res.status).toBe(200);
    expect(res.body.stages).toEqual([{ id: 'stage_ai', title: 'Bot Screening' }]);
    expect(JSON.stringify(res.body)).not.toContain('leak@example.invalid');
  });

  it('answers 503 when the runtime gates are closed — no client, no call', async () => {
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: null }))
      .get('/mc/jobs/job_1/stages');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('integration_disabled');
  });

  it('is admin-only', async () => {
    const deps = { store: fakeStore(), probeReader: null };
    expect((await request(appWithDeps('interviewer', deps)).get('/mc/jobs/job_1/stages')).status).toBe(403);
    expect((await request(appWithDeps(null, deps)).get('/mc/jobs/job_1/stages')).status).toBe(403);
  });

  it('rejects a malformed job id before any provider call', async () => {
    const jobInterviewPlanInfo = vi.fn();
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: { jobInterviewPlanInfo } as never }))
      .get('/mc/jobs/has%20space/stages');
    expect(res.status).toBe(400);
    expect(jobInterviewPlanInfo).not.toHaveBeenCalled();
  });

  it('reports a tenant failure as a sanitized capability error and enables nothing', async () => {
    const probeReader = {
      jobInterviewPlanInfo: async () => { throw new Error('403 Forbidden: tenant xyz lacks scope'); },
    };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/stages');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('probe_unavailable');
    expect(JSON.stringify(res.body)).not.toContain('tenant xyz');
  });
});

describe('GET /jobs/:externalJobId/feedback-form — read-only schema discovery', () => {
  const PLAN_WITH_FORM = {
    stages: [{
      id: 'stage_ai',
      title: 'AI Screening',
      candidateEmail: 'leak@example.invalid',
      activities: [{
        interviews: [{
          interviewId: 'iv_1',
          title: 'Hello Christy Screen',
          feedbackFormDefinition: {
            id: 'form_1',
            title: 'Hello Christy Feedback',
            formDefinition: {
              sections: [{
                title: 'Overall',
                descriptionHtml: '<p>tenant-html-must-not-surface</p>',
                fields: [{
                  isRequired: true,
                  field: {
                    id: 'field_overall',
                    type: 'ValueSelect',
                    path: 'overall_recommendation',
                    title: 'Overall Recommendation',
                    submittedValue: 'ANSWER-MUST-NOT-SURFACE',
                    selectableValues: [{ label: '4 - Strong Yes', value: '4' }],
                  },
                }],
              }],
            },
          },
        }],
      }],
    }],
  };

  it('returns sanitized form schema for an admin and no feedback content', async () => {
    const probeReader = { jobInterviewPlanInfo: async () => ({ results: PLAN_WITH_FORM }) };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/feedback-form');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.empty).toBe(false);
    expect(res.body.truncated).toBe(false);
    expect(res.body.forms).toHaveLength(1);
    expect(res.body.forms[0]).toMatchObject({
      formDefinitionId: 'form_1',
      title: 'Hello Christy Feedback',
      stageId: 'stage_ai',
      interviewId: 'iv_1',
      schemaAvailable: true,
      fieldCount: 1,
    });
    expect(res.body.forms[0].sections[0].fields[0]).toEqual({
      id: 'field_overall',
      title: 'Overall Recommendation',
      path: 'overall_recommendation',
      type: 'ValueSelect',
      required: true,
      options: [{ value: '4', label: '4 - Strong Yes' }],
      optionsTruncated: false,
    });

    const body = JSON.stringify(res.body);
    for (const forbidden of ['leak@example.invalid', 'ANSWER-MUST-NOT-SURFACE', 'tenant-html-must-not-surface']) {
      expect(body, `must not leak ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('makes exactly ONE provider read and calls no other member of the client', async () => {
    const calls: string[] = [];
    // Any member the handler touches beyond the single read throws, so
    // applicationFeedback.list or a mutation would fail the test loudly.
    const probeReader = new Proxy(
      {
        jobInterviewPlanInfo: async (jobId: string) => {
          calls.push(`jobInterviewPlanInfo:${jobId}`);
          return { results: PLAN_WITH_FORM };
        },
      } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          throw new Error(`route reached a forbidden client member: ${String(prop)}`);
        },
      },
    );
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/feedback-form');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['jobInterviewPlanInfo:job_1']);
  });

  it('is a GET-only surface — no mutating verb is mounted on the path', async () => {
    const deps = { store: fakeStore(), probeReader: null };
    const app = appWithDeps('admin', deps);
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[verb]('/mc/jobs/job_1/feedback-form').send({});
      expect(res.status, `${verb} must not be routable`).toBe(404);
    }
  });

  it('answers 503 when the integration is disabled — no client, no call', async () => {
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: null }))
      .get('/mc/jobs/job_1/feedback-form');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('integration_disabled');
  });

  it('is admin-only', async () => {
    const deps = { store: fakeStore(), probeReader: null };
    expect((await request(appWithDeps('interviewer', deps)).get('/mc/jobs/job_1/feedback-form')).status).toBe(403);
    expect((await request(appWithDeps('viewer', deps)).get('/mc/jobs/job_1/feedback-form')).status).toBe(403);
    expect((await request(appWithDeps(null, deps)).get('/mc/jobs/job_1/feedback-form')).status).toBe(403);
  });

  it('rejects a malformed job id before any provider call', async () => {
    const jobInterviewPlanInfo = vi.fn();
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: { jobInterviewPlanInfo } as never }))
      .get('/mc/jobs/has%20space/feedback-form');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_external_job_id');
    expect(jobInterviewPlanInfo).not.toHaveBeenCalled();
  });

  it('reports a provider failure as a sanitized 502 that echoes no provider body', async () => {
    const probeReader = {
      jobInterviewPlanInfo: async () => { throw new Error('403 Forbidden: tenant xyz lacks hiringProcessMetadataRead'); },
    };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/feedback-form');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'probe_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('tenant xyz');
  });

  it('reports an unusable provider body as a sanitized 502, not a half-built schema', async () => {
    const probeReader = { jobInterviewPlanInfo: async () => { throw new TypeError('unexpected token'); } };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/feedback-form');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('probe_unavailable');
  });

  it('reports a plan with no attached form as empty rather than as an error', async () => {
    const probeReader = { jobInterviewPlanInfo: async () => ({ results: { stages: [{ id: 's1', activities: [] }] } }) };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/feedback-form');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, forms: [], empty: true, truncated: false });
  });

  it('audits bounded COUNTS only — never a form, section, field or job id', async () => {
    const entries: AuditEntry[] = [];
    const previous = getAuditSink();
    setAuditSink(async (entry) => { entries.push(entry); });
    try {
      const probeReader = { jobInterviewPlanInfo: async () => ({ results: PLAN_WITH_FORM }) };
      const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
        .get('/mc/jobs/job_1/feedback-form');
      expect(res.status).toBe(200);
    } finally {
      setAuditSink(previous);
    }

    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toEqual({
      resource: 'ashby_job_feedback_forms',
      count: 1,
      field_count: 1,
      truncated: false,
    });
    // Tenant configuration ids must not spread beyond the one authenticated
    // response that asked for them.
    const audited = JSON.stringify(entries[0].metadata);
    for (const id of ['form_1', 'field_overall', 'stage_ai', 'iv_1']) {
      expect(audited, `audit must not carry ${id}`).not.toContain(id);
    }
  });

  it('surfaces a form the plan only NAMES as schema-unavailable, not as an empty form', async () => {
    const probeReader = {
      jobInterviewPlanInfo: async () => ({
        results: { stages: [{ id: 's1', interviews: [{ feedbackFormDefinitionId: 'form_ref_only' }] }] },
      }),
    };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/feedback-form');
    expect(res.status).toBe(200);
    expect(res.body.forms[0]).toMatchObject({ formDefinitionId: 'form_ref_only', schemaAvailable: false, sections: [], fieldCount: 0 });
  });
});

describe('retry — audited RPC statuses map to HTTP', () => {
  it('refuses to resurrect an operation on a terminal application', async () => {
    const store = fakeStore({ retryOperation: async () => ({ status: 'blocked_terminal' }) });
    const res = await request(appWithDeps('admin', { store, probeReader: null })).post(`/mc/operations/${UUID}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('blocked_terminal');
  });

  it('refuses once the attempt ceiling is reached', async () => {
    const store = fakeStore({ retryOperation: async () => ({ status: 'retry_exhausted' }) });
    const res = await request(appWithDeps('admin', { store, probeReader: null })).post(`/mc/operations/${UUID}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('retry_exhausted');
  });

  it('passes the acting admin through so the RPC can audit it', async () => {
    const actors: string[] = [];
    const store = fakeStore({ retryOperation: async (_id, actorId) => { actors.push(actorId); return { status: 'ok' }; } });
    await request(appWithDeps('admin', { store, probeReader: null })).post(`/mc/operations/${UUID}/retry`);
    expect(actors).toEqual([UUID]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /mappings/:id/archive — Mission Control's "Delete" (0109)
// ═══════════════════════════════════════════════════════════════════════

describe('POST /mappings/:id/archive — delete keeps history, pause first', () => {
  const PATH = `/mc/mappings/${UUID}/archive`;

  function archiveSpy(result: Awaited<ReturnType<MissionControlStore['archiveMapping']>>) {
    return vi.fn(async (_id: string, _actor: string) => result);
  }

  it('archives a paused mapping for an admin and passes the acting admin to the RPC', async () => {
    const archiveMapping = archiveSpy({ status: 'ok', alreadyArchived: false });
    const res = await request(appWithDeps('admin', { store: fakeStore({ archiveMapping }), probeReader: null })).post(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, already_archived: false });
    expect(archiveMapping).toHaveBeenCalledTimes(1);
    expect(archiveMapping).toHaveBeenCalledWith(UUID, UUID);
  });

  it('answers a repeat delete as success, flagged already_archived', async () => {
    const archiveMapping = archiveSpy({ status: 'ok', alreadyArchived: true });
    const res = await request(appWithDeps('admin', { store: fakeStore({ archiveMapping }), probeReader: null })).post(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, already_archived: true });
  });

  it('refuses an enabled mapping with 409 mapping_enabled — pause first', async () => {
    const archiveMapping = archiveSpy({ status: 'mapping_enabled' });
    const res = await request(appWithDeps('admin', { store: fakeStore({ archiveMapping }), probeReader: null })).post(PATH);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'mapping_enabled' });
  });

  it('answers 404 for an unknown mapping', async () => {
    const archiveMapping = archiveSpy({ status: 'not_found' });
    const res = await request(appWithDeps('admin', { store: fakeStore({ archiveMapping }), probeReader: null })).post(PATH);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not_found' });
  });

  it('passes any other RPC refusal through as 409 with its code', async () => {
    const archiveMapping = archiveSpy({ status: 'actor_required' });
    const res = await request(appWithDeps('admin', { store: fakeStore({ archiveMapping }), probeReader: null })).post(PATH);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'actor_required' });
  });

  it('answers a sanitized 500 when the store throws, echoing nothing it said', async () => {
    const archiveMapping = vi.fn(async () => { throw new Error('pg: permission denied for 10.0.0.5 archive_ashby_job_mapping'); });
    const res = await request(appWithDeps('admin', { store: fakeStore({ archiveMapping }), probeReader: null })).post(PATH);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
    expect(JSON.stringify(res.body)).not.toMatch(/pg:|10\.0\.0\.5|permission/);
  });

  it('rejects a malformed id with 400 before touching the store', async () => {
    const archiveMapping = archiveSpy({ status: 'ok', alreadyArchived: false });
    const res = await request(appWithDeps('admin', { store: fakeStore({ archiveMapping }), probeReader: null }))
      .post('/mc/mappings/not-a-uuid/archive');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_mapping_id' });
    expect(archiveMapping).not.toHaveBeenCalled();
  });

  it('is admin-only — interviewer, viewer and anonymous callers never reach the store', async () => {
    const archiveMapping = archiveSpy({ status: 'ok', alreadyArchived: false });
    const deps = { store: fakeStore({ archiveMapping }), probeReader: null };
    for (const role of ['interviewer', 'viewer', null]) {
      expect((await request(appWithDeps(role, deps)).post(PATH)).status, String(role)).toBe(403);
    }
    expect(archiveMapping).not.toHaveBeenCalled();
  });

  it('refuses an admin session with no acting user id (nothing to attribute the delete to)', async () => {
    const archiveMapping = archiveSpy({ status: 'ok', alreadyArchived: false });
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { authUser: unknown }).authUser = { appRole: 'admin' };
      next();
    });
    app.use('/mc', createAshbyMissionControlRouter({ store: fakeStore({ archiveMapping }), probeReader: null }));
    const res = await request(app).post(PATH);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'forbidden' });
    expect(archiveMapping).not.toHaveBeenCalled();
  });

  it('is blocked for a viewer by the global read-only guard exactly as /pause is', async () => {
    // Mirrors app.ts: auth → viewerReadOnly → router. The guard answers before
    // the route's own requireRole('admin') is ever consulted.
    const archiveMapping = archiveSpy({ status: 'ok', alreadyArchived: false });
    const setMappingStatus = vi.fn(async () => ({ status: 'ok' }));
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { authUser: unknown }).authUser = { id: UUID, appRole: 'viewer' };
      next();
    });
    app.use(viewerReadOnly);
    app.use('/mc', createAshbyMissionControlRouter({ store: fakeStore({ archiveMapping, setMappingStatus }), probeReader: null }));
    const pause = await request(app).post(`/mc/mappings/${UUID}/pause`);
    const archive = await request(app).post(PATH);
    expect(archive.status).toBe(403);
    expect(archive.status).toBe(pause.status);
    expect(archive.body).toEqual(pause.body);
    expect(archiveMapping).not.toHaveBeenCalled();
    expect(setMappingStatus).not.toHaveBeenCalled();
  });

  it('audits resource.delete with the opaque mapping id on success, and nothing on a refusal', async () => {
    // A realistic hex id: the shared all-digit fixture's last segment
    // ("111111111111") is itself redacted by the audit lib's 10+-digit
    // phone-number rule, which would hide what this test is checking.
    const MAPPING_ID = '5f0c1e2d-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
    const entries: AuditEntry[] = [];
    const previous = getAuditSink();
    setAuditSink(async (entry) => { entries.push(entry); });
    try {
      const ok = await request(appWithDeps('admin', {
        store: fakeStore({ archiveMapping: archiveSpy({ status: 'ok', alreadyArchived: false }) }), probeReader: null,
      })).post(`/mc/mappings/${MAPPING_ID}/archive`);
      expect(ok.status).toBe(200);
      const refused = await request(appWithDeps('admin', {
        store: fakeStore({ archiveMapping: archiveSpy({ status: 'mapping_enabled' }) }), probeReader: null,
      })).post(`/mc/mappings/${MAPPING_ID}/archive`);
      expect(refused.status).toBe(409);
    } finally {
      setAuditSink(previous);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe('resource.delete');
    expect(entries[0].statusCode).toBe(200);
    expect(entries[0].metadata).toEqual({ resource: 'ashby_mapping', mapping_id: MAPPING_ID, already_archived: false });
  });

  it('an archived mapping can no longer be paused or resumed — the RPC answers `archived`, surfaced as 409', async () => {
    const app = appWithDeps('admin', { store: fakeStore({ setMappingStatus: async () => ({ status: 'archived' }) }), probeReader: null });
    for (const action of ['pause', 'resume']) {
      const res = await request(app).post(`/mc/mappings/${UUID}/${action}`);
      expect(res.status, action).toBe(409);
      expect(res.body, action).toEqual({ ok: false, error: 'archived' });
    }
  });
});
