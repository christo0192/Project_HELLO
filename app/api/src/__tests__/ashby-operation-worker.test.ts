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
import { runClaimedAshbyOperation, channelForOperationKey } from '../integrations/ashby/operation-worker.js';
import type { RuntimeWorkflowStores, OperationClaimRow, WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { MaterializationStore, MaterializationMapping } from '../integrations/ashby/materialize.js';

const LINK = 'link_1';
const APP = 'app_1';
const ROLE = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

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
    parkOperationAwaitingDelivery: async () => 'ok',
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

describe('runClaimedAshbyOperation — manual channel parks, never "succeeds"', () => {
  it('parks the manual delivery as awaiting_manual_delivery and does NOT complete it', async () => {
    const complete = vi.fn(async () => 'ok' as const);
    const park = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({ completeOperation: complete, parkOperationAwaitingDelivery: park }),
    }));

    expect(r).toMatchObject({
      claimed: true, committed: true, staleLease: false, code: 'awaiting_manual_delivery',
    });
    // Minting an invite only produces a digest. Until an admin obtains a usable
    // link, `succeeded` would report work that has not happened.
    expect(complete).not.toHaveBeenCalled();
    expect(park).toHaveBeenCalledTimes(1);

    // The external anchor is an OPAQUE invite row id — never a token or URL.
    const [, leaseToken, anchor] = park.mock.calls[0] as unknown as [string, string, string | null];
    expect(leaseToken).toBe('lease-abc');
    expect(String(anchor)).not.toMatch(/^[a-f0-9]{64}$/); // not a token/digest
  });

  it('NEGATIVE CONTROL: completing instead of parking would report undelivered work as success', async () => {
    // If a future change reverts to completeOperation for the manual channel,
    // this assertion is what goes red.
    const park = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({ parkOperationAwaitingDelivery: park }),
    }));
    expect(r.claimed && r.code).not.toBe('manual_reissue');
    expect(r.claimed && r.code).toBe('awaiting_manual_delivery');
  });

  it('commits nothing when the lease was lost before parking', async () => {
    const r = await runClaimedAshbyOperation(deps({
      stores: stores({ parkOperationAwaitingDelivery: async () => 'not_owned' }),
    }));
    expect(r).toMatchObject({ claimed: true, committed: false, staleLease: true });
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
  it('records blocked_provider as a durable non-retryable failure, never succeeded', async () => {
    const complete = vi.fn(async () => 'ok' as const);
    const park = vi.fn(async () => 'ok' as const);
    const fail = vi.fn(async () => ({ outcome: 'failed' as const }));
    const emailClaim = { ...claim, operationKey: `ashby:invite:${APP}:email:pending` };
    const r = await runClaimedAshbyOperation(deps({
      resolveMappingForLink: async () => ({ ...mapping, deliveryMode: 'email' }),
      stores: stores({
        completeOperation: complete, parkOperationAwaitingDelivery: park,
        failOperation: fail, claimOperation: async () => emailClaim,
      }),
    }));
    expect(r).toMatchObject({ claimed: true, code: 'blocked_provider' });
    // Zero mail was sent, so the operation must NOT be recorded as success —
    // and it is not parked as a manual hand-off either.
    expect(complete).not.toHaveBeenCalled();
    expect(park).not.toHaveBeenCalled();
    // Durably failed with the sanitized reason, non-retryable (no spin).
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]).toEqual(['op_1', 'lease-abc', 'blocked_provider', false]);
  });

  it('does not report the blocked operation as committed', async () => {
    const emailClaim = { ...claim, operationKey: `ashby:invite:${APP}:email:pending` };
    const r = await runClaimedAshbyOperation(deps({
      resolveMappingForLink: async () => ({ ...mapping, deliveryMode: 'email' }),
      stores: stores({
        failOperation: async () => ({ outcome: 'failed' as const }),
        claimOperation: async () => emailClaim,
      }),
    }));
    expect(r).toMatchObject({ claimed: true, committed: false, staleLease: false });
  });
});

describe('channelForOperationKey — delivery_mode "both" resolves per operation', () => {
  it('reads the channel from the operation key, not the mapping mode', () => {
    expect(channelForOperationKey('ashby:invite:app_1:manual:pending', 'both')).toBe('manual');
    expect(channelForOperationKey('ashby:invite:app_1:email:pending', 'both')).toBe('email');
    expect(channelForOperationKey('ashby:invite:app_1:email:pending', 'manual')).toBe('email');
  });

  it('falls back to the mapping mode when the key is unusable', () => {
    expect(channelForOperationKey(null, 'email')).toBe('email');
    expect(channelForOperationKey(null, 'manual')).toBe('manual');
    // An ambiguous `both` with no key resolves to the only channel that can
    // actually deliver, rather than claiming the email channel worked.
    expect(channelForOperationKey(null, 'both')).toBe('manual');
    expect(channelForOperationKey('garbage-key', 'both')).toBe('manual');
  });
});

describe('delivery_mode "both" — one manual op parks, one email op blocks', () => {
  it('resolves each of the two operations to its own channel', async () => {
    const bothMapping = { ...mapping, deliveryMode: 'both' as const };
    const park = vi.fn(async () => 'ok' as const);
    const complete = vi.fn(async () => 'ok' as const);
    const fail = vi.fn(async () => ({ outcome: 'failed' as const }));

    const manual = await runClaimedAshbyOperation(deps({
      resolveMappingForLink: async () => bothMapping,
      stores: stores({
        claimOperation: async () => ({ ...claim, operationKey: `ashby:invite:${APP}:manual:pending` }),
        parkOperationAwaitingDelivery: park, completeOperation: complete, failOperation: fail,
      }),
    }));
    const email = await runClaimedAshbyOperation(deps({
      resolveMappingForLink: async () => bothMapping,
      stores: stores({
        claimOperation: async () => ({ ...claim, id: 'op_2', operationKey: `ashby:invite:${APP}:email:pending` }),
        parkOperationAwaitingDelivery: park, completeOperation: complete, failOperation: fail,
      }),
    }));

    expect(manual).toMatchObject({ code: 'awaiting_manual_delivery' });
    expect(email).toMatchObject({ code: 'blocked_provider' });
    // The email operation must never be parked as a manual hand-off, and
    // NEITHER operation may be recorded as `succeeded`: the manual one parks
    // until a human takes the link, the email one durably fails as blocked.
    expect(park).toHaveBeenCalledTimes(1);
    expect((park.mock.calls[0] as unknown as string[])[0]).toBe('op_1');
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]).toEqual(['op_2', 'lease-abc', 'blocked_provider', false]);
  });
});
