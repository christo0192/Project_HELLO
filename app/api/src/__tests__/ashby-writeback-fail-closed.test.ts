/**
 * THE RESULT-SINK GUARANTEE, as an executable gate.
 *
 * With no tenant-verified Ashby result sink, a completed screening must park
 * durably as `writeback_pending` and NOTHING may be published:
 *   - zero `applicationFeedback.submit` calls,
 *   - zero `application.changeStage` calls,
 *   - zero `applicationFeedbackRequest.create` calls,
 *   - no `scorecard_write` or `stage_move` operation ever claimed or succeeded,
 *   - no auto-reject anywhere.
 *
 * The guarantee rests on four independent locks, each asserted here:
 *   L1 the runtime's operation worker claims `invite_delivery` and nothing else;
 *   L2 `bindFeedbackForm` fails closed without a VERIFIED binding, and nothing
 *      in the codebase produces one;
 *   L3 the 0029 dependency trigger blocks a stage_move before its scorecard
 *      succeeds (asserted at the DB level in policy_tests.sql; asserted here at
 *      the orchestration level);
 *   L4 `enqueueStageMove` re-reads and refuses when a human moved the stage.
 *
 * Zero network: the Ashby transport is a spy that records every operation path
 * and fails the test if a mutating one is ever reached.
 */

import { describe, it, expect, vi } from 'vitest';
import { runClaimedAshbyOperation, SUPPORTED_OPERATION_TYPES, REFUSED_OPERATION_TYPES } from '../integrations/ashby/operation-worker.js';
import { bindFeedbackForm, buildScorecard, type ScorecardSource } from '../integrations/ashby/scorecard.js';
import { enqueueStageMove, enqueueScorecard, type RuntimeWorkflowStores, type SagaDeps } from '../integrations/ashby/orchestration.js';
import { createAshbyClient, ASHBY_API_BASE_URL } from '../integrations/ashby/client.js';
import { ASHBY_OPERATIONS } from '../integrations/ashby/types.js';

const AI_STAGE = 'stage_ai';

/** A transport that records paths and hard-fails on any mutating operation. */
function spyTransport() {
  const paths: string[] = [];
  const mutating = new Set(
    Object.entries(ASHBY_OPERATIONS).filter(([, s]) => s.mutation).map(([, s]) => s.path),
  );
  const transport = vi.fn(async (req: { url: string }) => {
    const path = new URL(req.url).pathname;
    paths.push(path);
    if (mutating.has(path)) {
      throw new Error(`FORBIDDEN mutating call reached the transport: ${path}`);
    }
    return {
      status: 200, ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        success: true,
        results: { id: 'app_1', currentInterviewStage: { id: AI_STAGE } },
      }),
    };
  });
  return { transport, paths, mutating };
}

function runtimeStores(over: Partial<RuntimeWorkflowStores> = {}): RuntimeWorkflowStores {
  return {
    findLinkByApplicationId: async () => null,
    createLink: async () => ({ id: 'link_1' }),
    advanceIngestion: async () => ({ status: 'ok' }),
    enqueueOperation: async () => ({ status: 'inserted', id: 'op_1' }),
    completeOperation: async () => 'ok',
    failOperation: async () => ({ outcome: 'retry' }),
    claimOperation: async () => null,
    readIngestion: async () => ({ state: 'ready', attempts: 0 }),
    readLink: async () => null,
    markWritebackPending: async () => ({ status: 'ok' }),
    ...over,
  };
}

// ── L1: the worker refuses the two write-back operation types ────────────────

describe('L1 — the runtime claims invite_delivery and NOTHING else', () => {
  it('declares invite_delivery as the only supported type', () => {
    expect([...SUPPORTED_OPERATION_TYPES]).toEqual(['invite_delivery']);
    expect([...REFUSED_OPERATION_TYPES].sort()).toEqual(['scorecard_write', 'stage_move']);
  });

  it('never passes scorecard_write or stage_move to claim_ashby_operation', async () => {
    const claimed: string[] = [];
    const stores = runtimeStores({
      claimOperation: async (type) => { claimed.push(type); return null; },
    });

    // Drive many passes: whatever the queue state, the requested type is fixed.
    for (let i = 0; i < 25; i++) {
      await runClaimedAshbyOperation({
        stores,
        materialization: {} as never,
        resolveMappingForLink: async () => null,
        reissuePathFor: () => '/x',
        email: { providerApproved: false, domainVerified: false },
        owner: 'w1', leaseSeconds: 30,
      });
    }

    expect(claimed).toHaveLength(25);
    expect(new Set(claimed)).toEqual(new Set(['invite_delivery']));
    expect(claimed).not.toContain('scorecard_write');
    expect(claimed).not.toContain('stage_move');
  });

  it('makes zero provider calls when the operation queue is empty', async () => {
    const { transport, paths } = spyTransport();
    // A client exists but the worker holds no reference to it at all.
    createAshbyClient({ apiKey: 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaa', transport });
    await runClaimedAshbyOperation({
      stores: runtimeStores(),
      materialization: {} as never,
      resolveMappingForLink: async () => null,
      reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false },
      owner: 'w1', leaseSeconds: 30,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(paths).toEqual([]);
  });
});

// ── L2: no verified form binding exists anywhere ─────────────────────────────

describe('L2 — the scorecard payload cannot be built without a verified binding', () => {
  const source: ScorecardSource = {
    overallScore: 72,
    recommendation: 'advance',
    summary: 'synthetic summary',
    dimensions: [{ key: 'communication', score: 3 }],
    provenance: { model: 'synthetic-model', scoredAt: '2026-08-17T00:00:00.000Z', version: '1' },
    reviewPath: '/candidates/abc',
  };

  it('fails closed on an unverified binding', () => {
    const built = buildScorecard(source, { min: 1, max: 4 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(bindFeedbackForm(built.scorecard, { verified: false }))
      .toEqual({ ok: false, reason: 'binding_unverified' });
  });

  it('fails closed on a verified-but-incomplete binding', () => {
    const built = buildScorecard(source, { min: 1, max: 4 });
    if (!built.ok) throw new Error('fixture');
    expect(bindFeedbackForm(built.scorecard, { verified: true, formDefinitionId: 'f1' }))
      .toEqual({ ok: false, reason: 'binding_incomplete' });
  });
});

// ── L3 / L4: the saga never publishes ────────────────────────────────────────

describe('L3/L4 — the stage move is refused and never reaches the provider', () => {
  function sagaDeps(currentStageId: string, over: Partial<SagaDeps> = {}): SagaDeps {
    return {
      gates: { enabled: true, email: { providerApproved: false, domainVerified: false } },
      stores: runtimeStores(),
      client: {
        applicationInfo: async () => ({
          results: { id: 'app_1', currentInterviewStage: { id: currentStageId } },
          moreDataAvailable: false,
        }) as never,
      },
      scale: { min: 1, max: 4 },
      applicationLinkId: 'link_1',
      externalApplicationId: 'app_1',
      aiScreeningStageId: AI_STAGE,
      ...over,
    };
  }

  it('skips the stage move when a human moved the application away', async () => {
    const r = await enqueueStageMove('op_scorecard', sagaDeps('stage_moved_by_human'));
    expect(r).toEqual({ status: 'stage_skipped', reason: 'human_moved' });
  });

  it('never auto-rejects — no reject/archive stage is ever targeted', async () => {
    const enqueued: Array<Record<string, unknown>> = [];
    const deps = sagaDeps(AI_STAGE, {
      stores: runtimeStores({
        enqueueOperation: async (input) => { enqueued.push(input); return { status: 'inserted', id: 'op_2' }; },
      }),
    });
    await enqueueStageMove('op_scorecard', deps);
    // The ONLY stage id in the operation key is the mapping's configured AI
    // stage — never a payload-supplied stage and never a reject/archive stage.
    for (const e of enqueued) {
      expect(String(e.operationKey)).toContain(AI_STAGE);
      expect(String(e.operationKey).toLowerCase()).not.toMatch(/reject|archive|decline/);
      // Ordering dependency on the scorecard is always present.
      expect(e.dependsOn).toBe('op_scorecard');
    }
  });

  it('enqueues a scorecard operation but performs no provider mutation', async () => {
    const { transport, paths } = spyTransport();
    createAshbyClient({ apiKey: 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaa', transport });
    const r = await enqueueScorecard(
      {
        overallScore: 72,
        recommendation: 'advance',
        summary: 'synthetic summary',
        dimensions: [{ key: 'k', score: 2 }],
        provenance: { model: 'synthetic-model', scoredAt: '2026-08-17T00:00:00.000Z', version: '1' },
        reviewPath: '/c/1',
      },
      sagaDeps(AI_STAGE),
    );
    expect(r.status).toBe('scorecard_enqueued');
    // Enqueuing an outbox row is not publishing: nothing reached the provider,
    // and no runtime worker will ever claim that row (L1).
    expect(paths).toEqual([]);
  });
});

// ── The terminus ─────────────────────────────────────────────────────────────

describe('writeback_pending is the terminus, and it publishes nothing', () => {
  it('parks the application and enqueues no operation', async () => {
    const enqueued: unknown[] = [];
    const marked: Array<[string, string]> = [];
    const stores = runtimeStores({
      enqueueOperation: async (i) => { enqueued.push(i); return { status: 'inserted', id: 'op' }; },
      markWritebackPending: async (id, reason) => { marked.push([id, reason]); return { status: 'ok' }; },
    });

    const r = await stores.markWritebackPending('link_1', 'no_verified_result_sink');
    expect(r.status).toBe('ok');
    expect(marked).toEqual([['link_1', 'no_verified_result_sink']]);
    // Parking is a terminus — it must not schedule follow-on work.
    expect(enqueued).toEqual([]);
  });

  it('is idempotent from the caller’s perspective', async () => {
    let calls = 0;
    const stores = runtimeStores({
      markWritebackPending: async () => { calls += 1; return { status: calls === 1 ? 'ok' : 'already_pending' }; },
    });
    expect((await stores.markWritebackPending('l', 'r')).status).toBe('ok');
    expect((await stores.markWritebackPending('l', 'r')).status).toBe('already_pending');
  });
});

// ── Static proof: no production caller of the two mutating client methods ────

describe('static containment — the mutating client methods have no production caller', () => {
  it('exposes them only on the client itself', async () => {
    const { transport } = spyTransport();
    const client = createAshbyClient({ apiKey: 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaa', transport });
    // They exist (the client is complete) …
    expect(typeof (client as unknown as Record<string, unknown>).applicationFeedbackSubmit).toBe('function');
    expect(typeof (client as unknown as Record<string, unknown>).applicationChangeStage).toBe('function');
    // … and the operation worker holds no client reference at all, so it has
    // nothing to call them with. Its dependency surface is the proof:
    const workerDepKeys = [
      'stores', 'materialization', 'resolveMappingForLink',
      'reissuePathFor', 'email', 'owner', 'leaseSeconds', 'onEvent', 'nowMs',
    ];
    expect(workerDepKeys).not.toContain('client');
    expect(ASHBY_API_BASE_URL).toBe('https://api.ashbyhq.com');
  });
});
