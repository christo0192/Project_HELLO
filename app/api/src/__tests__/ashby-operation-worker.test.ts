/**
 * Ashby operation worker — leased execution of invite_delivery.
 *
 * `claim_ashby_operation` shipped in 0031 with ZERO TypeScript callers, so the
 * lease token that `complete_ashby_operation` requires was unobtainable and the
 * outbox could never drain. These tests pin the executor:
 *
 *  - a stale/lost lease commits NOTHING;
 *  - a terminal application blocks execution even if the row was claimed;
 *  - a not-ready ingestion defers (retryable) rather than issuing an invite;
 *  - a paused/removed mapping defers rather than proceeding;
 *  - no adapter error escapes the worker.
 *
 * Zero network, zero DB.
 */

import { describe, it, expect, vi } from 'vitest';
import { runClaimedAshbyOperation } from '../integrations/ashby/operation-worker.js';
import type { RuntimeWorkflowStores, OperationClaimRow, WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { MaterializationStore, MaterializationMapping } from '../integrations/ashby/materialize.js';

const LINK = 'link_1';
const APP = 'app_1';
const ROLE = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

const claim: OperationClaimRow = {
  id: 'op_1',
  operationType: 'invite_delivery',
  applicationLinkId: LINK,
  leaseToken: 'lease-abc',
  attempts: 1,
  maxAttempts: 5,
  marker: null,
};

const link: WorkflowLinkRow = {
  id: LINK, externalApplicationId: APP, externalJobId: 'job_1', jobMappingId: 'map_1',
  candidateId: 'cand_1', sessionId: null, inviteId: null,
  lifecycle: 'processing', terminalState: null,
};

const mapping: MaterializationMapping = { id: 'map_1', roleId: ROLE, ownerId: OWNER, deliveryMode: 'manual' };

function materialization(): MaterializationStore {
  let n = 0;
  return {
    insertResume: async () => ({ id: `r${++n}` }),
    insertCandidate: async () => ({ id: `c${++n}` }),
    bindLinkColumn: async (i) => ({ bound: i.value, wonRace: true }),
    deleteOrphan: async () => {},
    createSession: async () => ({ id: `s${++n}` }),
    findActiveInvite: async () => null,
    insertInvite: async () => ({ id: `i${++n}` }),
  };
}

function stores(over: Partial<RuntimeWorkflowStores> = {}): RuntimeWorkflowStores {
  return {
    findLinkByApplicationId: async () => null,
    createLink: async () => ({ id: LINK }),
    advanceIngestion: async () => ({ status: 'ok' }),
    enqueueOperation: async () => ({ status: 'inserted', id: 'op' }),
    completeOperation: async () => 'ok',
    failOperation: async () => ({ outcome: 'retry' }),
    claimOperation: async () => claim,
    readIngestion: async () => ({ state: 'ready', attempts: 0 }),
    readLink: async () => link,
    markWritebackPending: async () => ({ status: 'ok' }),
    ...over,
  };
}

function deps(over: Partial<Parameters<typeof runClaimedAshbyOperation>[0]> = {}) {
  return {
    stores: stores(),
    materialization: materialization(),
    resolveMappingForLink: async () => mapping,
    reissuePathFor: (id: string) => `/ashby-mission-control?application=${id}`,
    email: { providerApproved: false, domainVerified: false },
    owner: 'w1',
    leaseSeconds: 30,
    nowMs: () => Date.parse('2026-08-17T00:00:00.000Z'),
    ...over,
  };
}

describe('runClaimedAshbyOperation — happy path', () => {
  it('claims, materializes an invite, and completes under the lease', async () => {
    const complete = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(deps({ stores: stores({ completeOperation: complete }) }));

    expect(r).toMatchObject({ claimed: true, committed: true, staleLease: false, code: 'manual_reissue' });
    expect(complete).toHaveBeenCalledTimes(1);
    // The external anchor is an OPAQUE invite row id — never a token or URL.
    const [, leaseToken, anchor] = complete.mock.calls[0] as unknown as [string, string, string | null];
    expect(leaseToken).toBe('lease-abc');
    expect(typeof anchor === 'string' || anchor === null).toBe(true);
    expect(String(anchor)).not.toMatch(/^[a-f0-9]{64}$/); // not a token/digest
  });

  it('reports not-claimed on an empty queue and touches nothing else', async () => {
    const readLink = vi.fn(async () => link);
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({ claimOperation: async () => null, readLink }),
    }));
    expect(r).toEqual({ claimed: false });
    expect(readLink).not.toHaveBeenCalled();
  });
});

describe('runClaimedAshbyOperation — fail-closed branches', () => {
  it('commits nothing when the lease was lost before completion', async () => {
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({ completeOperation: async () => 'not_owned' }),
    }));
    expect(r).toMatchObject({ claimed: true, committed: false, staleLease: true });
  });

  it('blocks a terminal application even after the row was claimed', async () => {
    const complete = vi.fn(async () => 'ok' as const);
    const fail = vi.fn(async () => ({ outcome: 'failed' as const }));
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({
        readLink: async () => ({ ...link, terminalState: 'withdrawn' }),
        completeOperation: complete,
        failOperation: fail,
      }),
    }));
    expect(r).toMatchObject({ claimed: true, committed: false, code: 'blocked_terminal' });
    expect(complete).not.toHaveBeenCalled();
    // Non-retryable: a withdrawn application must never be re-attempted.
    expect(fail).toHaveBeenCalledWith('op_1', 'lease-abc', 'terminal_cancel', false);
  });

  it('defers (retryable) while the ingestion has not reached ready', async () => {
    const fail = vi.fn(async () => ({ outcome: 'retry' as const }));
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({ readIngestion: async () => ({ state: 'scanning', attempts: 1 }), failOperation: fail }),
    }));
    expect(r).toMatchObject({ claimed: true, committed: false, code: 'ingestion_not_ready' });
    expect(fail).toHaveBeenCalledWith('op_1', 'lease-abc', 'ingestion_not_ready', true);
  });

  it('defers when the mapping is no longer enabled (a pause landing mid-flight)', async () => {
    const fail = vi.fn(async () => ({ outcome: 'retry' as const }));
    const r = await runClaimedAshbyOperation(deps({
      resolveMappingForLink: async () => null,
      stores: stores({ failOperation: fail }),
    }));
    expect(r).toMatchObject({ claimed: true, code: 'mapping_inactive' });
    expect(fail).toHaveBeenCalledWith('op_1', 'lease-abc', 'mapping_inactive', true);
  });

  it('fails non-retryably when the link row has vanished', async () => {
    const fail = vi.fn(async () => ({ outcome: 'failed' as const }));
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({ readLink: async () => null, failOperation: fail }),
    }));
    expect(r).toMatchObject({ claimed: true, code: 'link_missing' });
    expect(fail).toHaveBeenCalledWith('op_1', 'lease-abc', 'link_missing', false);
  });

  it('sanitizes a thrown adapter error and never rethrows', async () => {
    const fail = vi.fn(async () => ({ outcome: 'retry' as const }));
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({
        readIngestion: async () => { throw new Error('pg: connection to 10.0.0.5 failed for user svc'); },
        failOperation: fail,
      }),
    }));
    expect(r).toMatchObject({ claimed: true, code: 'operation_error' });
    // The provider/DB detail must never reach the recorded error code.
    expect(fail).toHaveBeenCalledWith('op_1', 'lease-abc', 'operation_error', true);
    expect(JSON.stringify(r)).not.toContain('10.0.0.5');
  });

  it('returns not-claimed (rather than throwing) when the claim itself errors', async () => {
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({ claimOperation: async () => { throw new Error('db_down'); } }),
    }));
    expect(r).toEqual({ claimed: false });
  });

  it('never rejects, whatever the adapters do', async () => {
    const hostile = stores({
      readLink: async () => { throw new Error('a'); },
      failOperation: async () => { throw new Error('b'); },
    });
    await expect(runClaimedAshbyOperation(deps({ stores: hostile }))).resolves.toMatchObject({ claimed: true });
  });
});

describe('runClaimedAshbyOperation — email channel', () => {
  it('completes the operation as blocked_provider with zero sends', async () => {
    const complete = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(deps({
      resolveMappingForLink: async () => ({ ...mapping, deliveryMode: 'email' }),
      stores: stores({ completeOperation: complete }),
    }));
    expect(r).toMatchObject({ claimed: true, code: 'blocked_provider' });
    // The operation is durably resolved (not retried forever) but nothing was sent.
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
