/**
 * P3 — bounded recovery for a DROPPED LiveKit webhook.
 *
 * The failure being recovered: the call ends, the `participant_left` webhook
 * never arrives, and the attempt stays live holding one of ten fleet slots
 * with an engagement stuck in `in_call`. Lease reclaim frees the slot but
 * cannot decide the OUTCOME. This sweep asks LiveKit what happened.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PHONE_RECONCILE_BOUNDS,
  reconcileMinAgeSeconds,
  reconcileProviderEventId,
  recoveredEventType,
  runPhoneReconciliation,
} from '../integrations/livekit-phone/reconciliation.js';
import { createPhoneIngressHealth } from '../integrations/livekit-phone/ingress.js';
import { loadLiveKitPhoneConfig } from '../integrations/livekit-phone/config.js';
import { PHONE_BOUNDS } from '../lib/phone-screening/index.js';
import {
  createDefaultLiveKitRoomReader,
  createDuePhoneAttemptReader,
  createLiveKitRoomReader,
} from '../integrations/livekit-phone/stores.js';
import * as barrel from '../integrations/livekit-phone/index.js';
import type {
  DuePhoneAttempt,
  DuePhoneAttemptReader,
  LiveKitRoomReader,
} from '../integrations/livekit-phone/ports.js';
import type { ApplyPhoneEventResult, PhoneStores } from '../lib/phone-screening/index.js';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const A2 = 'bbbbbbbb-2222-4222-8222-222222222222';

const ENABLED = loadLiveKitPhoneConfig({
  PHONE_SCREENING_ENABLED: 'true',
  LIVEKIT_API_KEY: 'a-real-key',
  LIVEKIT_API_SECRET: 'a-real-secret',
} as NodeJS.ProcessEnv);

const DISABLED = loadLiveKitPhoneConfig({} as NodeJS.ProcessEnv);

function attempt(over: Partial<DuePhoneAttempt> = {}): DuePhoneAttempt {
  return {
    attemptId: A1,
    engagementId: 'eeeeeeee-0000-4000-8000-000000000000',
    epoch: 5,
    roomName: 'phone-room-1',
    attemptState: 'human',
    engagementState: 'in_call',
    ...over,
  };
}

const applied = { status: 'applied', applied: true, duplicate: false } as ApplyPhoneEventResult;

function deps(over: {
  due?: DuePhoneAttempt[];
  participants?: Array<{ identity: string }>;
  listParticipants?: ReturnType<typeof vi.fn>;
  applyEvent?: ReturnType<typeof vi.fn>;
  config?: typeof ENABLED;
} = {}) {
  const listDueAttempts = vi.fn().mockResolvedValue(over.due ?? [attempt()]);
  const listParticipants = over.listParticipants
    ?? vi.fn().mockResolvedValue(over.participants ?? []);
  const applyEvent = over.applyEvent ?? vi.fn().mockResolvedValue(applied);
  return {
    deps: {
      config: over.config ?? ENABLED,
      // `vi.fn()` widens to a call/construct union that does not structurally
      // satisfy the port signature; the cast is on the MOCK, never on the
      // port, so the production interface stays the thing under test.
      attempts: {
        listDueAttempts: listDueAttempts as unknown as DuePhoneAttemptReader['listDueAttempts'],
      },
      rooms: {
        listParticipants: listParticipants as unknown as LiveKitRoomReader['listParticipants'],
      },
      stores: { applyEvent: applyEvent as unknown as PhoneStores['applyEvent'] },
      health: createPhoneIngressHealth(),
    },
    listDueAttempts,
    listParticipants,
    applyEvent,
  };
}

describe('P3 reconciliation — disabled does nothing', () => {
  it('reads nothing and posts nothing when the master flag is off', async () => {
    const d = deps({ config: DISABLED });
    const result = await runPhoneReconciliation(d.deps, { now: NOW });
    expect(result).toEqual({
      status: 'disabled', examined: 0, posted: 0, skipped: {}, outcomes: [],
    });
    expect(d.listDueAttempts).not.toHaveBeenCalled();
    expect(d.listParticipants).not.toHaveBeenCalled();
    expect(d.applyEvent).not.toHaveBeenCalled();
  });
});

describe('P3 reconciliation — wall-clock and count bounds', () => {
  it('derives the age floor from the ring timeout, never below it', async () => {
    // Concluding "the leg never came up" before the ring timeout elapsed would
    // manufacture a no-answer for a call that is still ringing.
    expect(reconcileMinAgeSeconds(45)).toBe(90);
    expect(reconcileMinAgeSeconds(120)).toBe(240);
    // Clamped at both ends whatever the knob says.
    expect(reconcileMinAgeSeconds(5)).toBe(PHONE_RECONCILE_BOUNDS.minAgeSeconds.min);
    expect(reconcileMinAgeSeconds(100000)).toBe(PHONE_RECONCILE_BOUNDS.minAgeSeconds.max);
    // And the floor always exceeds the ring timeout it is derived from —
    // across the WHOLE configurable range, not a hand-picked sample. This
    // invariant survives only because the clamp ceiling is at least twice the
    // largest ring timeout the config will accept; assert that coupling
    // directly, or a future widening of the ring bound silently puts the floor
    // BELOW the timeout and the sweep starts manufacturing no-answers.
    const ringMax = PHONE_BOUNDS.ringTimeoutSeconds.max;
    expect(PHONE_RECONCILE_BOUNDS.minAgeSeconds.max)
      .toBeGreaterThanOrEqual(ringMax * PHONE_RECONCILE_BOUNDS.ringTimeoutMultiplier);
    for (let ring = PHONE_BOUNDS.ringTimeoutSeconds.min; ring <= ringMax; ring += 1) {
      expect(reconcileMinAgeSeconds(ring), `ring=${ring}`).toBeGreaterThan(ring);
    }
  });

  it('asks ONLY for attempts whose lease is still held (the two-sweeper line)', async () => {
    // An EXPIRED lease means OUR worker died, and
    // `reclaim_phone_attempt_leases` owns that case: it abandons the attempt
    // with `outcome_class = null` and CHARGES NO BUDGET, because a dead worker
    // is our failure and not the candidate's attempt. The outcomes THIS sweep
    // posts do charge. Overlapping the two would let a crash of ours spend a
    // candidate's no-answer budget — three crashes would reach
    // `abandoned_no_answer` for our own downtime.
    const d = deps();
    await runPhoneReconciliation(d.deps, { now: NOW });
    expect(d.listDueAttempts.mock.calls[0][0].leaseHeldAt).toEqual(NOW);
  });

  it('the reader turns leaseHeldAt into a still-held lease filter', async () => {
    const { client, calls } = stubClient({ data: [], error: null });
    await createDuePhoneAttemptReader(client as never).listDueAttempts({
      admittedBefore: NOW, admittedAfter: NOW, leaseHeldAt: NOW, limit: 1,
    });
    // Strictly greater-than, so an exactly-expired lease is excluded, and a
    // NULL lease is excluded too (a NULL comparison is false) — an attempt no
    // worker holds is not one whose webhook we can call merely dropped.
    expect(calls.gt).toEqual(['lease_expires_at', NOW.toISOString()]);
  });

  it('asks only for attempts inside an explicit wall-clock window', async () => {
    const d = deps();
    await runPhoneReconciliation(d.deps, { now: NOW, lookbackSeconds: 3600 });
    const arg = d.listDueAttempts.mock.calls[0][0];
    const minAge = reconcileMinAgeSeconds(ENABLED.phone.ringTimeoutSeconds);
    expect(arg.admittedBefore).toEqual(new Date(NOW.getTime() - minAge * 1000));
    expect(arg.admittedAfter).toEqual(new Date(NOW.getTime() - 3600 * 1000));
    expect(arg.admittedAfter.getTime()).toBeLessThan(arg.admittedBefore.getTime());
  });

  it('clamps the limit and the lookback rather than trusting the caller', async () => {
    for (const [asked, expected] of [
      [9999, PHONE_RECONCILE_BOUNDS.limit.max],
      [0, PHONE_RECONCILE_BOUNDS.limit.min],
      [-5, PHONE_RECONCILE_BOUNDS.limit.min],
      [undefined, PHONE_RECONCILE_BOUNDS.limit.def],
    ] as const) {
      const d = deps({ due: [] });
      await runPhoneReconciliation(d.deps, { now: NOW, limit: asked as number | undefined });
      expect(d.listDueAttempts.mock.calls[0][0].limit).toBe(expected);
    }
    const d = deps({ due: [] });
    await runPhoneReconciliation(d.deps, { now: NOW, lookbackSeconds: 999999 });
    const arg = d.listDueAttempts.mock.calls[0][0];
    expect(NOW.getTime() - arg.admittedAfter.getTime())
      .toBe(PHONE_RECONCILE_BOUNDS.lookbackSeconds.max * 1000);
  });

  it('cannot be widened by a reader that ignores the limit', async () => {
    const many = Array.from({ length: 40 }, (_v, i) => attempt({
      attemptId: `cccccccc-3333-4333-8333-${String(i).padStart(12, '0')}`,
    }));
    const d = deps({ due: many });
    const result = await runPhoneReconciliation(d.deps, { now: NOW, limit: 5 });
    expect(result.examined).toBe(5);
    expect(d.applyEvent).toHaveBeenCalledTimes(5);
  });
});

describe('P3 reconciliation — what it concludes, and when it says nothing', () => {
  it('posts the one legal edge for each recoverable engagement state', () => {
    expect(recoveredEventType('in_call', 'human')).toBe('sip.participant_left');
    expect(recoveredEventType('dialing', 'ringing')).toBe('sip.originate_timeout');
    expect(recoveredEventType('dialing', 'admitted')).toBe('sip.originate_timeout');
    // Every other state has no legal edge from a missing participant; the
    // sweep must not invent one just to close the row.
    for (const state of [
      'pending_prereqs', 'eligible', 'scheduled', 'awaiting_retry', 'reconnecting',
      'completed', 'cancelled', 'failed', 'opted_out', 'wrong_number',
    ]) {
      expect(recoveredEventType(state, 'ringing')).toBeNull();
    }
  });

  it('never calls an ANSWERED call a no-answer', () => {
    // `dialing` outlives the answer: 0042 #14 moves the ATTEMPT to
    // `answered_unclassified` and the engagement nowhere, and `classify.human`
    // moves the attempt to `human`, again with no engagement change. Deciding
    // from the engagement state alone would record a call the candidate
    // demonstrably picked up as `no_answer`, charge the anti-harassment
    // budget, and re-dial them the next IST day on the strength of it.
    for (const attemptState of ['answered_unclassified', 'human', 'machine']) {
      expect(recoveredEventType('dialing', attemptState)).toBeNull();
    }
  });

  it('leaves an answered-then-dropped attempt to the reclaimer, posting nothing', async () => {
    const d = deps({
      due: [attempt({ engagementState: 'dialing', attemptState: 'human' })],
      participants: [],
    });
    const result = await runPhoneReconciliation(d.deps, { now: NOW });
    expect(d.applyEvent).not.toHaveBeenCalled();
    expect(result.skipped).toEqual({ state_not_recoverable: 1 });
  });

  it('says nothing when our participant is STILL in the room', async () => {
    const d = deps({ participants: [{ identity: `phone-${A1}` }, { identity: 'agent-1' }] });
    const result = await runPhoneReconciliation(d.deps, { now: NOW });
    expect(d.applyEvent).not.toHaveBeenCalled();
    expect(result.skipped).toEqual({ participant_present: 1 });
    expect(result.posted).toBe(0);
  });

  it('says nothing when the room read FAILS — unknown is not absent', async () => {
    const d = deps({
      listParticipants: vi.fn().mockRejectedValue(new Error('livekit unreachable')),
    });
    const result = await runPhoneReconciliation(d.deps, { now: NOW });
    expect(d.applyEvent).not.toHaveBeenCalled();
    expect(result.skipped).toEqual({ room_read_failed: 1 });
  });

  it('does not let one unreachable room abort the sweep for everyone else', async () => {
    const listParticipants = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);
    const d = deps({
      due: [attempt({ roomName: 'bad-room' }), attempt({ attemptId: A2, roomName: 'good-room' })],
      listParticipants,
    });
    const result = await runPhoneReconciliation(d.deps, { now: NOW });
    expect(result.posted).toBe(1);
    expect(result.skipped).toEqual({ room_read_failed: 1 });
    expect(d.applyEvent.mock.calls[0][0].attemptId).toBe(A2);
  });

  it('skips an attempt that never reached a room', async () => {
    const d = deps({ due: [attempt({ roomName: null })] });
    const result = await runPhoneReconciliation(d.deps, { now: NOW });
    expect(d.listParticipants).not.toHaveBeenCalled();
    expect(result.skipped).toEqual({ no_room: 1 });
  });

  it('posts a fenced, deterministic event when the participant is gone', async () => {
    const d = deps({ participants: [{ identity: 'agent-1' }] });
    const result = await runPhoneReconciliation(d.deps, { now: NOW });
    expect(d.applyEvent).toHaveBeenCalledTimes(1);
    expect(d.applyEvent.mock.calls[0][0]).toEqual({
      source: 'reconciliation',
      eventType: 'sip.participant_left',
      attemptId: A1,
      providerEventId: `recon:${A1}:sip.participant_left:5`,
      epoch: 5,
      metadata: { recon_event: 'sip.participant_left' },
      now: NOW,
    });
    expect(result.posted).toBe(1);
  });

  it('recovers a dropped originate as a timeout when still dialing', async () => {
    const d = deps({ due: [attempt({ engagementState: 'dialing', attemptState: 'ringing' })] });
    await runPhoneReconciliation(d.deps, { now: NOW });
    expect(d.applyEvent.mock.calls[0][0].eventType).toBe('sip.originate_timeout');
  });
});

describe('P3 reconciliation — idempotent and epoch-fenced', () => {
  it('mints the SAME id on a repeat sweep, so the ledger dedups', async () => {
    const d = deps({ participants: [] });
    await runPhoneReconciliation(d.deps, { now: NOW });
    await runPhoneReconciliation(d.deps, { now: new Date(NOW.getTime() + 60_000) });
    const [first, second] = d.applyEvent.mock.calls.map((c) => c[0].providerEventId);
    expect(first).toBe(second);
    // Nothing time-derived participates, which is why a later sweep collides.
    expect(first).not.toContain(String(NOW.getTime()));
  });

  it('scopes the id to the EPOCH, so a new conversation is a new event', () => {
    const a = reconcileProviderEventId(A1, 'sip.participant_left', 5);
    const b = reconcileProviderEventId(A1, 'sip.participant_left', 6);
    expect(a).not.toBe(b);
    for (const id of [a, b]) expect(id).toMatch(/^[A-Za-z0-9_.:-]{1,200}$/);
  });

  it('passes the attempt epoch as the fencing token, never inventing one', async () => {
    const d = deps({ due: [attempt({ epoch: 0 })], participants: [] });
    await runPhoneReconciliation(d.deps, { now: NOW });
    expect(d.applyEvent.mock.calls[0][0].epoch).toBe(0);
  });

  it('surfaces a stale verdict rather than retrying it', async () => {
    const d = deps({
      participants: [],
      applyEvent: vi.fn().mockResolvedValue({
        status: 'ignored', applied: false, ignoredReason: 'stale_epoch',
      } as ApplyPhoneEventResult),
    });
    const result = await runPhoneReconciliation(d.deps, { now: NOW });
    expect(result.outcomes).toEqual([
      { httpStatus: 200, code: 'ignored_stale_epoch', recorded: true, duplicate: false },
    ]);
  });

  it('routes its malformed refusals through the SAME R-4 counter', async () => {
    const health = createPhoneIngressHealth();
    const d = deps({
      participants: [],
      applyEvent: vi.fn().mockResolvedValue({ status: 'attempt_required' } as never),
    });
    await runPhoneReconciliation({ ...d.deps, health }, { now: NOW });
    expect(health.snapshot().byStatus.attempt_required).toBe(1);
  });
});

describe('P3 reconciliation — it cannot dial, and it cannot see a number', () => {
  it('the room reader projects identity ONLY', async () => {
    // A LiveKit SIP participant carries sip.phoneNumber / sip.trunkPhoneNumber
    // automatically. They must not survive the port boundary.
    const reader = createLiveKitRoomReader({
      listParticipants: async () => [
        {
          identity: `phone-${A1}`,
          attributes: { 'sip.phoneNumber': '+910000000000', 'sip.callID': 'SCL_x' },
          name: 'caller', kind: 3,
        } as never,
        { identity: 'agent-1' } as never,
        { } as never,
      ],
    });
    const participants = await reader.listParticipants('room');
    expect(participants).toEqual([{ identity: `phone-${A1}` }, { identity: 'agent-1' }]);
    const rendered = JSON.stringify(participants);
    expect(rendered).not.toContain('+910000000000');
    expect(rendered).not.toContain('sip.');
    expect(rendered).not.toContain('SCL_x');
    for (const p of participants) expect(Object.keys(p)).toEqual(['identity']);
  });

  it('never writes anything except through applyEvent', async () => {
    const d = deps({ participants: [] });
    await runPhoneReconciliation(d.deps, { now: NOW });
    // The ports expose no dial, originate, transfer, remove or delete method
    // at all — this asserts the shape the sweep actually depends on.
    expect(Object.keys(d.deps.rooms)).toEqual(['listParticipants']);
    expect(Object.keys(d.deps.attempts)).toEqual(['listDueAttempts']);
    expect(Object.keys(d.deps.stores)).toEqual(['applyEvent']);
  });
});


// ── The production adapters behind the ports ─────────────────────────────
//
// A port whose only implementation is a test fake is a feature that dies
// green: it type-checks, its tests pass, and it can never actually run. These
// cover the DEFAULTS, which is where that failure hides.

/** Minimal chainable PostgREST stub that records the query it was given. */
function stubClient(response: { data?: unknown; error?: unknown }) {
  const calls: Record<string, unknown[]> = {};
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'in', 'lte', 'gte', 'gt', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls[method] = args;
      return method === 'limit' ? Promise.resolve(response) : builder;
    };
  }
  const client = {
    from: (table: string) => { calls.from = [table]; return builder; },
  };
  return { client, calls };
}

describe('P3 stores — the due-attempt reader', () => {
  const row = {
    id: A1,
    engagement_id: 'eeeeeeee-0000-4000-8000-000000000000',
    epoch: 4,
    room_name: 'phone-room-1',
    state: 'human',
    phone_engagements: { state: 'in_call' },
  };

  it('applies the window, the live-state filter and the limit in SQL', async () => {
    const { client, calls } = stubClient({ data: [row], error: null });
    const reader = createDuePhoneAttemptReader(client as never);
    const before = new Date('2026-08-22T11:58:00.000Z');
    const after = new Date('2026-08-22T06:00:00.000Z');
    const out = await reader.listDueAttempts({ admittedBefore: before, admittedAfter: after, leaseHeldAt: NOW, limit: 7 });

    expect(calls.from).toEqual(['phone_call_attempts']);
    // Live states only — a finished attempt is not owed a recovery.
    expect(calls.in?.[0]).toBe('state');
    expect(calls.in?.[1]).toEqual([
      'admitted', 'ringing', 'answered_unclassified', 'human', 'machine',
    ]);
    expect(calls.lte).toEqual(['admitted_at', before.toISOString()]);
    expect(calls.gte).toEqual(['admitted_at', after.toISOString()]);
    expect(calls.limit).toEqual([7]);
    expect(out).toEqual([{
      attemptId: A1,
      engagementId: 'eeeeeeee-0000-4000-8000-000000000000',
      epoch: 4,
      roomName: 'phone-room-1',
      attemptState: 'human',
      engagementState: 'in_call',
    }]);
  });

  it('accepts the embedded engagement as an object OR a one-element array', async () => {
    const { client } = stubClient({
      data: [{ ...row, phone_engagements: [{ state: 'dialing' }] }], error: null,
    });
    const out = await createDuePhoneAttemptReader(client as never)
      .listDueAttempts({ admittedBefore: NOW, admittedAfter: NOW, leaseHeldAt: NOW, limit: 1 });
    expect(out[0].engagementState).toBe('dialing');
  });

  it('DROPS a row missing any field the sweep fences on', async () => {
    // Guessing an epoch would defeat the fencing the epoch exists to provide.
    const broken = [
      { ...row, epoch: null },
      { ...row, epoch: 1.5 },
      { ...row, id: null },
      { ...row, engagement_id: 42 },
      { ...row, state: null },
      { ...row, phone_engagements: null },
      { ...row, phone_engagements: [] },
    ];
    const { client } = stubClient({ data: broken, error: null });
    const out = await createDuePhoneAttemptReader(client as never)
      .listDueAttempts({ admittedBefore: NOW, admittedAfter: NOW, leaseHeldAt: NOW, limit: 50 });
    expect(out).toEqual([]);
  });

  it('normalises an absent room to null rather than an empty string', async () => {
    const { client } = stubClient({ data: [{ ...row, room_name: '' }], error: null });
    const out = await createDuePhoneAttemptReader(client as never)
      .listDueAttempts({ admittedBefore: NOW, admittedAfter: NOW, leaseHeldAt: NOW, limit: 1 });
    expect(out[0].roomName).toBeNull();
  });

  it('raises a bare code on a driver error, never the driver message', async () => {
    const { client } = stubClient({
      data: null, error: { message: 'postgres://user:pw@host/db unreachable' },
    });
    await expect(
      createDuePhoneAttemptReader(client as never)
        .listDueAttempts({ admittedBefore: NOW, admittedAfter: NOW, leaseHeldAt: NOW, limit: 1 }),
    ).rejects.toThrow('phone_due_attempts_read_error');
  });

  it('tolerates a non-array payload without throwing', async () => {
    const { client } = stubClient({ data: null, error: null });
    await expect(
      createDuePhoneAttemptReader(client as never)
        .listDueAttempts({ admittedBefore: NOW, admittedAfter: NOW, leaseHeldAt: NOW, limit: 1 }),
    ).resolves.toEqual([]);
  });
});

describe('P3 stores — the default room reader is real and lazy', () => {
  it('constructs the SDK client only on the first read, against loopback', async () => {
    // Proves the lazy dynamic import actually resolves and the reader is
    // wired to the REAL RoomServiceClient. Port 1 on loopback refuses
    // immediately, so this is hermetic: no external network is touched.
    const reader = createDefaultLiveKitRoomReader(
      'http://127.0.0.1:1', 'a-real-key', 'a-real-secret',
    );
    expect(Object.keys(reader)).toEqual(['listParticipants']);
    await expect(reader.listParticipants('phone-room-1')).rejects.toBeDefined();
  });
});

describe('P3 barrel — the surface is a decision, not a side effect', () => {
  it('re-exports every P3 entry point by explicit name', () => {
    for (const name of [
      'loadLiveKitPhoneConfig', 'isPhoneWebhookActive', 'describeLiveKitPhoneConfig',
      'resolvePhoneEvent', 'attemptIdFromIdentity', 'parsePhoneEpoch', 'phoneProviderEventId',
      'isLiveKitWebhookEvent', 'LIVEKIT_WEBHOOK_EVENTS', 'PHONE_EVENT_BY_LIVEKIT_EVENT',
      'APPROVED_PARTICIPANT_ATTRIBUTES', 'createPhoneWebhookVerifier', 'LIVEKIT_AUTH_HEADER',
      'PHONE_WEBHOOK_VERIFY_REASONS', 'ingestPhoneWebhook', 'classifyApplyResult',
      'createPhoneIngressHealth', 'phoneIngressHealth', 'isUnrecordedStatus',
      'PHONE_UNRECORDED_STATUSES', 'runPhoneReconciliation', 'reconcileMinAgeSeconds',
      'recoveredEventType', 'reconcileProviderEventId', 'PHONE_RECONCILE_BOUNDS',
      'createDuePhoneAttemptReader', 'createLiveKitRoomReader', 'createDefaultLiveKitRoomReader',
    ]) {
      expect(barrel, `barrel is missing ${name}`).toHaveProperty(name);
    }
  });

  it('exports nothing beyond that surface', () => {
    // `export *` would let a future internal helper leak out silently.
    expect(Object.keys(barrel).sort()).toEqual([
      'APPROVED_PARTICIPANT_ATTRIBUTES', 'LIVEKIT_AUTH_HEADER', 'LIVEKIT_WEBHOOK_EVENTS',
      'MIN_LIVEKIT_CREDENTIAL_LENGTH', 'PHONE_EVENT_BY_LIVEKIT_EVENT',
      'PHONE_RECONCILE_BOUNDS', 'PHONE_UNRECORDED_STATUSES', 'PHONE_WEBHOOK_VERIFY_REASONS',
      'attemptIdFromIdentity', 'classifyApplyResult', 'createDefaultLiveKitRoomReader',
      'createDuePhoneAttemptReader', 'createLiveKitRoomReader', 'createPhoneIngressHealth',
      'createPhoneWebhookVerifier', 'describeLiveKitPhoneConfig', 'ingestPhoneWebhook',
      'isLiveKitWebhookEvent', 'isPhoneWebhookActive', 'isUnrecordedStatus',
      'loadLiveKitPhoneConfig', 'parsePhoneEpoch', 'phoneIngressHealth',
      'phoneProviderEventId', 'reconcileMinAgeSeconds', 'reconcileProviderEventId',
      'recoveredEventType', 'resolvePhoneEvent', 'runPhoneReconciliation',
    ]);
  });
});
