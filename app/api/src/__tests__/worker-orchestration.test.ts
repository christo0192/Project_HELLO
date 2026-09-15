/**
 * PR B — the on-demand Fly worker orchestration SERVICE
 * (`createWorkerOrchestrationService`) and the reaper runtime gate.
 *
 * The two invariants under test (design §2.1):
 *   I1  ensureReadyWorker returns 'ready' ONLY after observing a ready/busy
 *       lease. Every failure exit is non-ready.
 *   I2  Every failure exit after a claim tears the machine down (stop + release
 *       + reset), and reapWorkers stops any non-stopped machine with no live
 *       room.
 *
 * All seams are fakes — no network, no DB, no timers.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createWorkerOrchestrationService,
  type RpcCaller,
  type WorkerOrchestrationDeps,
} from '../lib/worker-orchestration.js';
import { createWorkerOrchestrationRuntime } from '../lib/worker-orchestration-runtime.js';
import { FlyMachinesError } from '../lib/fly-machines.js';

const APP = 'project-hello-phone-voice';
const SESSION = '99999999-8888-4777-8666-555555555555';
const MACHINE = 'd891234abcd567';

/**
 * A lease snapshot as the readiness poll reads it.
 *
 * Defaults to "still claimed by SESSION", because that is what the row says
 * for the whole of a normal poll. The epoch defaults to NULL — these fakes do
 * not model the fencing token, and null is the honest "no epoch to compare"
 * rather than a number that would silently decide the fence either way. A test
 * that wants the machine taken away underneath the poll says so explicitly,
 * which is the only route to the claim-lost branch and the point of carrying
 * the claim on this seam at all.
 */
function lease(
  state: string | null,
  over: { claimedSessionId?: string | null; epoch?: number | null } = {},
) {
  return {
    state,
    claimedSessionId:
      'claimedSessionId' in over ? (over.claimedSessionId ?? null) : SESSION,
    epoch: over.epoch ?? null,
  };
}

/**
 * A structured-event recorder wired through the service's `onEvent` sink. The
 * component logger's meta allowlist drops count fields (released/stopFailed) and
 * the app from the log LINE, so asserting on the log alone can only see the
 * event KIND. The sink receives the FULL payload, so these tests observe both
 * the kind AND the counts — which is exactly what P4 requires ("count released
 * only on confirmed stop; add a stopFailed count to the swept event").
 */
function eventRecorder(): {
  onEvent: (kind: string, payload: Record<string, unknown>) => void;
  kinds: () => string[];
  find: (kind: string) => Record<string, unknown> | undefined;
  all: (kind: string) => Record<string, unknown>[];
} {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  return {
    onEvent: (kind, payload) => events.push({ kind, payload }),
    kinds: () => events.map((e) => e.kind),
    find: (kind) => events.find((e) => e.kind === kind)?.payload,
    all: (kind) => events.filter((e) => e.kind === kind).map((e) => e.payload),
  };
}

/** A fake Fly client recording calls; each verb resolvable/rejectable per test. */
function fakeFly(
  overrides: Partial<
    Record<'startMachine' | 'stopMachine' | 'waitForState' | 'listMachines', () => Promise<unknown>>
  > = {},
) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async startMachine(app: string, id: string) {
        calls.push(`start:${app}:${id}`);
        return overrides.startMachine ? overrides.startMachine() : {};
      },
      async stopMachine(app: string, id: string) {
        calls.push(`stop:${app}:${id}`);
        return overrides.stopMachine ? overrides.stopMachine() : {};
      },
      async waitForState(app: string, id: string, state: string) {
        calls.push(`wait:${app}:${id}:${state}`);
        return overrides.waitForState ? overrides.waitForState() : {};
      },
      async listMachines(app: string) {
        calls.push(`list:${app}`);
        return overrides.listMachines ? overrides.listMachines() : [];
      },
      async getMachine(_app: string, id: string) { return { id, state: 'stopped', raw: {} } as never; },
    } as never,
  };
}

/**
 * What an UNSCRIPTED RPC answers.
 *
 * `{status:'ok'}` for most, but `release_voice_worker` answers `draining` —
 * the status the real RPC returns when the caller DID hold the claim, which is
 * the situation every test that does not say otherwise is in. It matters
 * because the teardown now treats that answer as the proof of ownership and
 * stops nothing without it; a fake that said `ok` would make every cleanup
 * assertion pass or fail for the wrong reason.
 */
function defaultEnvelope(name: string): { status: string } {
  return name === 'release_voice_worker'
    ? { status: 'draining' }
    : { status: 'ok' };
}

/** An RPC caller that returns scripted envelopes per name, recording calls. */
function fakeRpc(script: Record<string, { data?: unknown; error?: { message?: string } | null }[]>): {
  rpc: RpcCaller;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const cursors: Record<string, number> = {};
  const rpc: RpcCaller = async (name, args) => {
    calls.push({ name, args });
    const seq = script[name];
    if (!seq || seq.length === 0) return { data: defaultEnvelope(name), error: null };
    const i = Math.min(cursors[name] ?? 0, seq.length - 1);
    cursors[name] = (cursors[name] ?? 0) + 1;
    const entry = seq[i];
    return { data: entry.data ?? { status: 'ok' }, error: entry.error ?? null };
  };
  return { rpc, calls };
}

function baseDeps(over: Partial<WorkerOrchestrationDeps> = {}): WorkerOrchestrationDeps {
  const fly = fakeFly();
  const { rpc } = fakeRpc({});
  return {
    enabled: true,
    rpc,
    fly: fly.client,
    readLeaseState: async () => lease('ready'),
    roomIsLive: async () => false,
    now: () => 1_000,
    sleep: async () => {},
    ...over,
  };
}

describe('ensureReadyWorker', () => {
  it('happy path: claim → start → wait → ready', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 7 } }],
    });
    // Lease not ready on the first read, ready on the second — proves the poll.
    let reads = 0;
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => {
        reads += 1;
        return lease(reads >= 2 ? 'ready' : 'starting');
      },
    }));
    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r).toEqual({ status: 'ready', machineId: MACHINE });
    expect(fly.calls).toContain(`start:${APP}:${MACHINE}`);
    expect(fly.calls).toContain(`wait:${APP}:${MACHINE}:started`);
    // Never cleaned up on the happy path.
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.some((c) => c.name === 'release_voice_worker')).toBe(false);
  });

  it('no_capacity: returns immediately, never starts a machine', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({ claim_voice_worker: [{ data: { status: 'no_capacity' } }] });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r).toEqual({ status: 'no_capacity' });
    expect(fly.calls).toEqual([]); // no start, no stop
  });

  it('ready-timeout: cleans up (stop+release+reset), returns timeout, NEVER ready', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
    });
    // A monotonically advancing clock so the wall-clock deadline is reached.
    let t = 0;
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => lease('starting'), // never becomes ready
      now: () => (t += 5_000),
      sleep: async () => {},
    }));
    const r = await svc.ensureReadyWorker({
      app: APP, pipeline: 'phone', sessionId: SESSION, readyTimeoutSec: 5,
    });
    expect(r).toEqual({ status: 'timeout' });
    // I2: the started machine was cleaned up.
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
    const names = calls.map((c) => c.name);
    expect(names).toContain('release_voice_worker');
    expect(names).toContain('reset_voice_worker');
  });

  it('a machine RE-CLAIMED mid-poll is never returned ready, and is NOT stopped', async () => {
    // The race this fences. Our poll runs for up to two minutes. In that window
    // the reaper can stop and reset our machine — our session's room has no
    // participants yet, so the liveness check cannot spare it — and the next
    // dial claims the freed slot. Its worker then posts ITS readiness ping.
    //
    // Reading only `state`, this poll saw `ready`, believed it, and dialled a
    // candidate into somebody else's machine. Since the worker now takes one
    // job at a time, the second dispatch is DECLINED and that candidate hears
    // silence — the exact failure a saturated pool produces.
    const OTHER = '11111111-2222-4333-8444-555555555555';
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 4 } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      // `ready` — but ready for OTHER.
      readLeaseState: async () => lease('ready', { claimedSessionId: OTHER }),
    }));

    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    // I1: not ready. The readiness we saw was not ours to act on.
    expect(r).toEqual({ status: 'timeout' });
    // And — the part that matters — we did NOT tear down the live call that
    // now owns this machine. `stopMachine` and `reset_voice_worker` are both
    // unconditional on the session, so running them here would have killed it.
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.map((c) => c.name)).not.toContain('reset_voice_worker');
    // Not even the release is attempted. The release CAS is NOT epoch-fenced,
    // so on the sibling shape below (same session, newer epoch) it answers
    // `draining` and the teardown would believe it holds a claim it does not.
    // On an unprovable claim the only safe move is to touch nothing.
    expect(calls.map((c) => c.name)).not.toContain('release_voice_worker');
  });

  it('a HIGHER epoch on our own session id is still a lost claim', async () => {
    // The subtler shape: the reaper released us, and the SAME session was
    // re-admitted and re-claimed the same machine. The session id matches, so
    // only the fencing token can tell the two claims apart — and acting on the
    // newer claim's readiness with the older claim's epoch would mark busy,
    // release and stop against a lifecycle that is no longer ours.
    //
    // THIS shape is why the claim-lost branch runs no teardown at all.
    // `release_voice_worker` matches on (app, machine_id, claimed_session_id)
    // and NOT on epoch (0079), so for the SAME session at a newer epoch it
    // answers `draining` — the very proof the teardown reads as ownership —
    // and would stop the machine the newer claim just booted. The fake is left
    // UNSCRIPTED deliberately, so it answers `draining` exactly as the real RPC
    // would; the assertions below pass only because nothing asks it.
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 4 } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => lease('ready', { epoch: 5 }),
    }));

    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r).toEqual({ status: 'timeout' });
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.map((c) => c.name)).not.toContain('reset_voice_worker');
    expect(calls.map((c) => c.name)).not.toContain('release_voice_worker');
  });

  it('an EQUAL epoch is OUR claim — readiness on it is believed', async () => {
    // The guard must fence a NEWER claim, not our own. `claim_voice_worker`
    // returns the epoch it bumped TO, and nothing but another claim moves it,
    // so the row we are polling carries exactly that number for our whole
    // lifecycle. An off-by-one here (`>=` for `>`) would make every dial
    // time out — the guard would be strictly worse than no guard.
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 4 } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => lease('ready', { epoch: 4 }),
    }));

    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r).toEqual({ status: 'ready', machineId: MACHINE });
  });

  it('a STOPPED lease (null claim) is "not yet", not "lost" — the budget is spent', async () => {
    // A row whose claim is null is merely between states from our side; it is
    // not evidence that somebody else owns the machine. Treating it as lost
    // would abandon a claim on the first read of a row mid-transition and
    // turn an ordinary slow boot into a refused dial.
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
      // What the REAL RPC answers for the row this test describes. A `stopped`
      // lease carries a null claim, and `release_voice_worker` requires
      // `claimed_session_id = p_session_id and state in ('starting','ready',
      // 'busy','draining')` — so it matches nothing and answers
      // `already_released`. Scripted explicitly because the unscripted default
      // is `draining`, which would let this test assert a teardown production
      // would never perform.
      release_voice_worker: [{ data: { status: 'already_released' } }],
    });
    let reads = 0;
    let t = 0;
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => {
        reads += 1;
        return lease('stopped', { claimedSessionId: null });
      },
      now: () => (t += 5_000),
    }));

    const r = await svc.ensureReadyWorker({
      app: APP, pipeline: 'phone', sessionId: SESSION, readyTimeoutSec: 20,
    });
    expect(r).toEqual({ status: 'timeout' });
    // It kept polling rather than bailing on read one — the point of the test.
    expect(reads).toBeGreaterThan(1);
    // Teardown asked, could not prove ownership, and stopped nothing. The
    // machine is left to the reaper, which is the designed backstop.
    expect(calls.map((c) => c.name)).toContain('release_voice_worker');
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.map((c) => c.name)).not.toContain('reset_voice_worker');
  });

  it('a room that no longer EXISTS is not live, and the reaper stops its machine', async () => {
    // The wedge that ate half the pool for four days. `listParticipants` throws
    // `not_found` once a room is gone; the reaper reads any throw as "liveness
    // unknown" and SPARES — so the machine whose room had already been torn
    // down was spared on every pass, for ever, while its lease sat `ready`
    // with a 32-hour-dead heartbeat. A missing room is not unknown; it is
    // empty.
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [{ machine_id: MACHINE, state: 'ready', claimed_session_id: SESSION }],
      }],
      list_orphaned_voice_worker_leases: [{ data: [] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      roomIsLive: async () => {
        // The shape the LiveKit server SDK raises for a room that is gone.
        throw Object.assign(new Error('requested room does not exist'), { code: 'not_found' });
      },
    }));

    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(1);
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
  });

  it('a room check that fails for ANY OTHER reason still spares the machine', async () => {
    // The rule the not-found translation must not erode: never stop a machine
    // on an unproven-dead room. A transport error proves nothing.
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [{ machine_id: MACHINE, state: 'ready', claimed_session_id: SESSION }],
      }],
      list_orphaned_voice_worker_leases: [{ data: [] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      roomIsLive: async () => { throw new Error('ECONNRESET'); },
    }));

    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
  });

  it('teardown does NOT reset a machine Fly refused to stop', async () => {
    // `reset_voice_worker` returns the lease to the claimable pool. Doing that
    // for a machine still running hands a live VM to the next session, which
    // is how one machine ends up with two calls on it. The reaper already
    // refuses this; the claim teardown now refuses it too.
    const fly = fakeFly({
      stopMachine: async () => { throw new FlyMachinesError('server', { operation: 'stopMachine' }); },
    });
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
    });
    let t = 0;
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => lease('starting'),
      now: () => (t += 5_000),
    }));

    const r = await svc.ensureReadyWorker({
      app: APP, pipeline: 'phone', sessionId: SESSION, readyTimeoutSec: 5,
    });
    expect(r).toEqual({ status: 'timeout' });
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.map((c) => c.name)).not.toContain('reset_voice_worker');
  });

  it('a release that THROWS proves nothing, so teardown stops nothing', async () => {
    // Fail-open to the reaper, which is the designed backstop. The alternative
    // — stopping on an unproven claim — is the destructive direction, and the
    // only cost of this one is a machine that idles until the reaper's grace.
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
      release_voice_worker: [{ error: { message: 'boom' } }],
    });
    let t = 0;
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => lease('starting'),
      now: () => (t += 5_000),
    }));

    const r = await svc.ensureReadyWorker({
      app: APP, pipeline: 'phone', sessionId: SESSION, readyTimeoutSec: 5,
    });
    expect(r).toEqual({ status: 'timeout' });
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.map((c) => c.name)).not.toContain('reset_voice_worker');
  });

  it('fly-start error: cleans up and returns error (never ready)', async () => {
    const fly = fakeFly({
      startMachine: async () => { throw new FlyMachinesError('server', { operation: 'startMachine' }); },
    });
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r.status).toBe('error');
    // I2: cleanup ran even though start threw.
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.map((c) => c.name)).toContain('reset_voice_worker');
  });

  it('fly-start TIMEOUT maps to timeout status and cleans up', async () => {
    const fly = fakeFly({
      waitForState: async () => { throw new FlyMachinesError('timeout', { operation: 'waitForState' }); },
    });
    const { rpc } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r).toEqual({ status: 'timeout' });
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
  });
});

describe('releaseWorker', () => {
  it('release → stop → reset, in order', async () => {
    const order: string[] = [];
    // `draining` is what the real `release_voice_worker` answers when the
    // caller DID hold the claim — and holding the claim is the premise of this
    // test. The teardown now treats that answer as its proof of ownership, so
    // a fake that said `ok` would assert the ordering against a path
    // production never takes.
    const rpc: RpcCaller = async (name) => {
      order.push(name);
      return {
        data: { status: name === 'release_voice_worker' ? 'draining' : 'ok' },
        error: null,
      };
    };
    const fly = {
      async startMachine() { return {}; },
      async stopMachine() { order.push('stop'); return {}; },
      async waitForState() { return {}; },
      async listMachines() { return []; },
      async getMachine() { return {} as never; },
    } as never;
    const svc = createWorkerOrchestrationService(baseDeps({ fly, rpc }));
    await svc.releaseWorker({ app: APP, machineId: MACHINE, sessionId: SESSION });
    expect(order).toEqual(['release_voice_worker', 'stop', 'reset_voice_worker']);
  });

  it('a fly stop error is fail-open but NO LONGER resets — the machine is still running', async () => {
    // BEHAVIOUR CHANGE, deliberate. This used to reset the lease even when the
    // stop had failed, which returns a machine that is STILL RUNNING to the
    // claimable pool — and a machine handed to a second session while the
    // first is live on it is how one box ends up with two calls. The reaper
    // has always refused this ("do NOT reset a machine we did not confirm
    // stopped"); the release path now refuses it too, and the lease is left
    // non-`stopped` so the reaper retries it.
    const names: string[] = [];
    const rpc: RpcCaller = async (name) => {
      names.push(name);
      return {
        data: { status: name === 'release_voice_worker' ? 'draining' : 'ok' },
        error: null,
      };
    };
    const fly = fakeFly({
      stopMachine: async () => { throw new FlyMachinesError('server', { operation: 'stopMachine' }); },
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    await expect(
      svc.releaseWorker({ app: APP, machineId: MACHINE, sessionId: SESSION }),
    ).resolves.toBeUndefined();
    expect(names).toContain('release_voice_worker');
    expect(names).not.toContain('reset_voice_worker');
  });

  it('releases NOTHING for a claim it cannot prove is ours', async () => {
    // The same ownership proof the claim teardown uses, on the path
    // `releaseGatedWorker` takes from the dialer. `already_released` means the
    // reaper (or another session) got here first; stopping then would end
    // whatever is running now.
    const names: string[] = [];
    const rpc: RpcCaller = async (name) => {
      names.push(name);
      return {
        data: { status: name === 'release_voice_worker' ? 'already_released' : 'ok' },
        error: null,
      };
    };
    const fly = fakeFly();
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    await svc.releaseWorker({ app: APP, machineId: MACHINE, sessionId: SESSION });
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
    expect(names).not.toContain('reset_voice_worker');
  });
});

describe('releaseWorkerBySession — the restart-safe terminal-release choke point', () => {
  it('drains by session → stops the named machine → resets', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      release_voice_worker_by_session: [
        { data: { status: 'draining', machine_id: MACHINE, epoch: 4 } },
      ],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    await svc.releaseWorkerBySession({ app: APP, sessionId: SESSION });
    // Released by SESSION (no machineId needed — the restart-safe property).
    const rel = calls.find((c) => c.name === 'release_voice_worker_by_session');
    expect(rel?.args.p_session_id).toBe(SESSION);
    expect(rel?.args).not.toHaveProperty('p_machine_id');
    // Then stops + resets the machine the RPC named.
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.some((c) => c.name === 'reset_voice_worker' && c.args.p_machine_id === MACHINE)).toBe(true);
  });

  it('already_released (idempotent) → no stop, no reset', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      release_voice_worker_by_session: [{ data: { status: 'already_released' } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    await svc.releaseWorkerBySession({ app: APP, sessionId: SESSION });
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.some((c) => c.name === 'reset_voice_worker')).toBe(false);
  });

  it('fail-open on a fly stop error: does NOT reset (lets the reaper retry)', async () => {
    const fly = fakeFly({
      stopMachine: async () => { throw new FlyMachinesError('server', { operation: 'stopMachine' }); },
    });
    const { rpc, calls } = fakeRpc({
      release_voice_worker_by_session: [
        { data: { status: 'draining', machine_id: MACHINE, epoch: 4 } },
      ],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    await expect(svc.releaseWorkerBySession({ app: APP, sessionId: SESSION })).resolves.toBeUndefined();
    // We could not confirm the stop, so we must NOT reset the row.
    expect(calls.some((c) => c.name === 'reset_voice_worker')).toBe(false);
  });
});

describe('releaseTerminalSessions — the prompt-release pass', () => {
  const SESS_A = '11111111-1111-4111-8111-111111111111';
  const SESS_B = '22222222-2222-4222-8222-222222222222';
  const MACH_A = 'aaaa1111';
  const MACH_B = 'bbbb2222';

  it('releases every terminal-session lease by session id', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      list_terminal_session_leases: [{
        data: [
          { machine_id: MACH_A, claimed_session_id: SESS_A, state: 'busy', epoch: 1 },
          { machine_id: MACH_B, claimed_session_id: SESS_B, state: 'ready', epoch: 2 },
        ],
      }],
      release_voice_worker_by_session: [
        { data: { status: 'draining', machine_id: MACH_A, epoch: 1 } },
        { data: { status: 'draining', machine_id: MACH_B, epoch: 2 } },
      ],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.releaseTerminalSessions({ app: APP });
    expect(r.released).toBe(2);
    expect(fly.calls).toContain(`stop:${APP}:${MACH_A}`);
    expect(fly.calls).toContain(`stop:${APP}:${MACH_B}`);
    // Each release addressed BY SESSION.
    const rels = calls.filter((c) => c.name === 'release_voice_worker_by_session');
    expect(rels.map((c) => c.args.p_session_id)).toEqual([SESS_A, SESS_B]);
  });

  it('empty terminal list → nothing released, no Fly call', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({ list_terminal_session_leases: [{ data: [] }] });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.releaseTerminalSessions({ app: APP });
    expect(r.released).toBe(0);
    expect(fly.calls).toEqual([]);
  });

  it('a list transport error is swallowed (released 0), never throws', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_terminal_session_leases: [{ error: { message: 'boom' } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.releaseTerminalSessions({ app: APP });
    expect(r.released).toBe(0);
  });

  it('P4: a Fly STOP failure does NOT count as released, fires terminal_release_stop_failed, and reports stopFailed', async () => {
    // The defect P4 flags: a failed stop left the machine RUNNING, but the pass
    // still counted it `released` and reported success. Now the machine is not
    // counted released, a distinct event fires, and the swept event carries a
    // stopFailed tally.
    const rec = eventRecorder();
    const fly = fakeFly({
      stopMachine: async () => { throw new FlyMachinesError('server', { operation: 'stopMachine' }); },
    });
    const { rpc } = fakeRpc({
      list_terminal_session_leases: [{
        data: [{ machine_id: MACH_A, claimed_session_id: SESS_A, state: 'busy', epoch: 1 }],
      }],
      release_voice_worker_by_session: [
        { data: { status: 'draining', machine_id: MACH_A, epoch: 1 } },
      ],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc, onEvent: rec.onEvent }));
    const r = await svc.releaseTerminalSessions({ app: APP });
    // Machine still running ⇒ NOT released.
    expect(r.released).toBe(0);
    // The per-session stop-failed event fired.
    expect(rec.kinds()).toContain('terminal_release_stop_failed');
    // The swept event carries a stopFailed count of 1 and released 0.
    const swept = rec.find('terminal_release_swept');
    expect(swept).toMatchObject({ released: 0, stopFailed: 1 });
  });

  it('P4: a release-RPC throw fires terminal_release_rpc_error and never counts released', async () => {
    const rec = eventRecorder();
    const fly = fakeFly();
    // The list succeeds; the per-session release RPC throws.
    const rpc: RpcCaller = async (name, _args) => {
      if (name === 'list_terminal_session_leases') {
        return {
          data: [{ machine_id: MACH_A, claimed_session_id: SESS_A, state: 'busy', epoch: 1 }],
          error: null,
        };
      }
      if (name === 'release_voice_worker_by_session') throw new Error('db down');
      return { data: { status: 'ok' }, error: null };
    };
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc, onEvent: rec.onEvent }));
    const r = await svc.releaseTerminalSessions({ app: APP });
    expect(r.released).toBe(0);
    // Nothing was stopped (the release never resolved a machine id).
    expect(fly.calls).toEqual([]);
    expect(rec.kinds()).toContain('terminal_release_rpc_error');
    // Swept event still reports honestly: 0 released, 0 stopFailed.
    expect(rec.find('terminal_release_swept')).toMatchObject({ released: 0, stopFailed: 0 });
  });

  it('P4: a reset failure still counts released (the machine IS stopped) and fires terminal_release_reset_failed', async () => {
    const rec = eventRecorder();
    const fly = fakeFly(); // stop succeeds
    const rpc: RpcCaller = async (name, _args) => {
      if (name === 'list_terminal_session_leases') {
        return {
          data: [{ machine_id: MACH_A, claimed_session_id: SESS_A, state: 'busy', epoch: 1 }],
          error: null,
        };
      }
      if (name === 'release_voice_worker_by_session') {
        return { data: { status: 'draining', machine_id: MACH_A, epoch: 1 }, error: null };
      }
      if (name === 'reset_voice_worker') throw new Error('reset failed');
      return { data: { status: 'ok' }, error: null };
    };
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc, onEvent: rec.onEvent }));
    const r = await svc.releaseTerminalSessions({ app: APP });
    // The expensive thing (a running machine) is gone, so it counts released.
    expect(r.released).toBe(1);
    expect(fly.calls).toContain(`stop:${APP}:${MACH_A}`);
    expect(rec.kinds()).toContain('terminal_release_reset_failed');
    expect(rec.find('terminal_release_swept')).toMatchObject({ released: 1, stopFailed: 0 });
  });

  it('CRASH RECOVERY: a FRESH service instance (no in-process state) releases by session', async () => {
    // The process that placed the dial is gone; it never persisted a machineId.
    // A new service instance still releases the claim, because the release path
    // is addressed by SESSION and the machine<->session map lives in the DB.
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      list_terminal_session_leases: [{
        data: [{ machine_id: MACH_A, claimed_session_id: SESS_A, state: 'busy', epoch: 1 }],
      }],
      release_voice_worker_by_session: [
        { data: { status: 'draining', machine_id: MACH_A, epoch: 1 } },
      ],
    });
    // A brand-new service — nothing carried over from the dial.
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.releaseTerminalSessions({ app: APP });
    expect(r.released).toBe(1);
    expect(fly.calls).toContain(`stop:${APP}:${MACH_A}`);
    // The ONLY input the release needed was the session id — no machineId was
    // ever handed to this instance.
    const rel = calls.find((c) => c.name === 'release_voice_worker_by_session');
    expect(rel?.args.p_session_id).toBe(SESS_A);
  });

  it('P9 CRASH RECOVERY (failure case): release RPC throws on the FRESH instance ⇒ P4 event fires, machine NOT released; the reaper is the backstop', async () => {
    // The honest other half of the crash-recovery story. A fresh instance that
    // cannot reach the DB to release does NOT silently report success: the
    // rpc-error event fires, nothing is counted released, and nothing is
    // stopped. The reaper (list_reapable_voice_workers + LiveKit liveness) is
    // the backstop that eventually stops the machine — this pass does not.
    const rec = eventRecorder();
    const fly = fakeFly();
    const rpc: RpcCaller = async (name) => {
      if (name === 'list_terminal_session_leases') {
        return {
          data: [{ machine_id: MACH_A, claimed_session_id: SESS_A, state: 'busy', epoch: 1 }],
          error: null,
        };
      }
      if (name === 'release_voice_worker_by_session') throw new Error('db unreachable');
      return { data: { status: 'ok' }, error: null };
    };
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc, onEvent: rec.onEvent }));
    const r = await svc.releaseTerminalSessions({ app: APP });
    expect(r.released).toBe(0);
    expect(fly.calls).not.toContain(`stop:${APP}:${MACH_A}`);
    expect(rec.kinds()).toContain('terminal_release_rpc_error');
  });

  it('EPOCH FENCING (PR#68): only releases sessions the terminal-list returned; a re-claimed live session is never in that list', async () => {
    // The prompt-release pass is TERMINAL-GATED: it releases exactly the
    // sessions `list_terminal_session_leases` returns, and that RPC only returns
    // leases whose call_session is already terminal. A terminal session is never
    // re-adopted (reconnect adopts only RESUMABLE sessions), so a re-claimed live
    // session — the "winner" of PR#68 — can never appear here, and its lease is
    // never touched by this pass. We prove the pass releases ONLY the listed
    // session and nothing else.
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      list_terminal_session_leases: [{
        data: [{ machine_id: MACH_A, claimed_session_id: SESS_A, state: 'draining', epoch: 5 }],
      }],
      release_voice_worker_by_session: [
        { data: { status: 'draining', machine_id: MACH_A, epoch: 5 } },
      ],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    await svc.releaseTerminalSessions({ app: APP });
    const rels = calls.filter((c) => c.name === 'release_voice_worker_by_session');
    // Exactly one release, for exactly the terminal session — never SESS_B.
    expect(rels).toHaveLength(1);
    expect(rels[0].args.p_session_id).toBe(SESS_A);
    expect(fly.calls).not.toContain(`stop:${APP}:${MACH_B}`);
  });
});

describe('markBusy — the second liveness signal', () => {
  it('CAS on (machine, session, epoch)', async () => {
    const { rpc, calls } = fakeRpc({
      mark_voice_worker_busy: [{ data: { status: 'busy', machine_id: MACHINE, epoch: 9 } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ rpc }));
    await svc.markBusy({ app: APP, machineId: MACHINE, sessionId: SESSION, epoch: 9 });
    const c = calls.find((x) => x.name === 'mark_voice_worker_busy');
    expect(c?.args).toMatchObject({
      p_app: APP, p_machine_id: MACHINE, p_session_id: SESSION, p_epoch: 9,
    });
  });

  it('a stale/failed CAS is swallowed — never throws (the lease is already ready)', async () => {
    const rpc: RpcCaller = async () => { throw new Error('db down'); };
    const svc = createWorkerOrchestrationService(baseDeps({ rpc }));
    await expect(
      svc.markBusy({ app: APP, machineId: MACHINE, sessionId: SESSION, epoch: 9 }),
    ).resolves.toBeUndefined();
  });
});

describe('FULL LIFECYCLE E2E (no PSTN): claim → ready → busy → terminal release → reusable', () => {
  it('drives the whole loop against a stateful in-memory lease + Fly', async () => {
    // A tiny stateful model of ONE pool machine: the lease state, the Fly
    // machine state, and the bound session. No network, no DB, no timers.
    let leaseState = 'stopped';
    let machineState = 'stopped';
    let boundSession: string | null = null;
    let epoch = 0;

    const fly = {
      async startMachine() { machineState = 'started'; return {}; },
      async stopMachine() { machineState = 'stopped'; return {}; },
      async waitForState() { return {}; },
      async listMachines() { return []; },
      async getMachine() { return {} as never; },
    } as never;

    const rpc: RpcCaller = async (name, args) => {
      switch (name) {
        case 'claim_voice_worker':
          if (leaseState !== 'stopped') return { data: { status: 'no_capacity' }, error: null };
          leaseState = 'starting';
          boundSession = args.p_session_id as string;
          epoch += 1;
          return { data: { status: 'claimed', machine_id: MACHINE, epoch }, error: null };
        case 'mark_voice_worker_busy':
          if (leaseState === 'ready' || leaseState === 'busy') leaseState = 'busy';
          return { data: { status: 'busy', machine_id: MACHINE, epoch }, error: null };
        case 'release_voice_worker_by_session':
          if (boundSession === (args.p_session_id as string)
              && ['starting', 'ready', 'busy', 'draining'].includes(leaseState)) {
            leaseState = 'draining';
            return { data: { status: 'draining', machine_id: MACHINE, epoch }, error: null };
          }
          return { data: { status: 'already_released' }, error: null };
        case 'reset_voice_worker':
          leaseState = 'stopped';
          boundSession = null;
          return { data: { status: 'stopped', machine_id: MACHINE }, error: null };
        case 'list_terminal_session_leases':
          // The session went terminal (the test drives this by calling release).
          return { data: [], error: null };
        default:
          return { data: { status: 'ok' }, error: null };
      }
    };

    const svc = createWorkerOrchestrationService(baseDeps({
      fly,
      rpc,
      // The readiness poll observing 'ready' models the worker's readiness ping
      // (mark_voice_worker_ready) landing — flip the model to 'ready' so the
      // subsequent markBusy CAS (ready -> busy) has a live 'ready' lease.
      readLeaseState: async () => {
        if (leaseState === 'starting') leaseState = 'ready';
        // The claim identity comes from the MODEL, not from the fixture
        // default: this lease is reused by a second session later in the test,
        // and the readiness poll now fences on exactly that.
        return lease(leaseState, { claimedSessionId: boundSession });
      },
    }));

    // 1. claim → start → ready
    const ready = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(ready).toEqual({ status: 'ready', machineId: MACHINE });
    expect(machineState).toBe('started');
    // The readiness poll observed 'ready' (mapped from 'starting' in the model).

    // 2. busy at dial success
    await svc.markBusy({ app: APP, machineId: MACHINE, sessionId: SESSION, epoch });
    expect(leaseState).toBe('busy');

    // 3. terminal → release by session → stop + reset
    await svc.releaseWorkerBySession({ app: APP, sessionId: SESSION });
    expect(machineState).toBe('stopped');
    expect(leaseState).toBe('stopped');
    expect(boundSession).toBeNull();

    // 4. the pool row is REUSABLE — a new session can claim the same machine.
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const reclaim = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: OTHER });
    expect(reclaim).toEqual({ status: 'ready', machineId: MACHINE });
    expect(boundSession).toBe(OTHER);
  });

  it('P7: E2E THROUGH THE REAL LOOP ENTRY POINT — list_terminal_session_leases → releaseTerminalSessions → drain → stop → reset → reusable', async () => {
    // The 15s loop calls releaseTerminalSessions, NOT releaseWorkerBySession.
    // This drives that real function against the stateful model, with the
    // terminal lease surfaced by list_terminal_session_leases exactly as the DB
    // would once the bound session goes terminal.
    let leaseState = 'stopped';
    let machineState = 'stopped';
    let boundSession: string | null = null;
    let sessionTerminal = false;
    let epoch = 0;

    const fly = {
      async startMachine() { machineState = 'started'; return {}; },
      async stopMachine() { machineState = 'stopped'; return {}; },
      async waitForState() { return {}; },
      async listMachines() { return []; },
      async getMachine() { return {} as never; },
    } as never;

    const rpc: RpcCaller = async (name, args) => {
      switch (name) {
        case 'claim_voice_worker':
          if (leaseState !== 'stopped') return { data: { status: 'no_capacity' }, error: null };
          leaseState = 'starting';
          boundSession = args.p_session_id as string;
          sessionTerminal = false;
          epoch += 1;
          return { data: { status: 'claimed', machine_id: MACHINE, epoch }, error: null };
        case 'list_terminal_session_leases':
          // Only surfaces a live lease whose bound session has gone terminal —
          // exactly the DB predicate. Drives the pass's candidate list.
          if (boundSession !== null && sessionTerminal
              && ['starting', 'ready', 'busy', 'draining'].includes(leaseState)) {
            return {
              data: [{ machine_id: MACHINE, claimed_session_id: boundSession, state: leaseState, epoch }],
              error: null,
            };
          }
          return { data: [], error: null };
        case 'release_voice_worker_by_session':
          if (boundSession === (args.p_session_id as string)
              && ['starting', 'ready', 'busy', 'draining'].includes(leaseState)) {
            leaseState = 'draining';
            return { data: { status: 'draining', machine_id: MACHINE, epoch }, error: null };
          }
          return { data: { status: 'already_released' }, error: null };
        case 'reset_voice_worker':
          leaseState = 'stopped';
          boundSession = null;
          return { data: { status: 'stopped', machine_id: MACHINE }, error: null };
        default:
          return { data: { status: 'ok' }, error: null };
      }
    };

    const svc = createWorkerOrchestrationService(baseDeps({
      fly,
      rpc,
      readLeaseState: async () => {
        if (leaseState === 'starting') leaseState = 'ready';
        // The claim identity comes from the MODEL, not from the fixture
        // default: this lease is reused by a second session later in the test,
        // and the readiness poll now fences on exactly that.
        return lease(leaseState, { claimedSessionId: boundSession });
      },
    }));

    // Claim + ready, then the call ends and the session goes terminal.
    const ready = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(ready).toEqual({ status: 'ready', machineId: MACHINE });
    expect(machineState).toBe('started');
    sessionTerminal = true; // the bound session reached a terminal status

    // The LOOP'S entry point drives the whole chain: list → drain → stop → reset.
    const swept = await svc.releaseTerminalSessions({ app: APP });
    expect(swept.released).toBe(1);
    expect(machineState).toBe('stopped');
    expect(leaseState).toBe('stopped');
    expect(boundSession).toBeNull();

    // The lease is REUSABLE: a fresh session claims the same machine.
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const reclaim = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: OTHER });
    expect(reclaim).toEqual({ status: 'ready', machineId: MACHINE });
    expect(boundSession).toBe(OTHER);
  });
});

describe('reapWorkers', () => {
  const A = 'aaaa1111';
  const B = 'bbbb2222';
  const SESS_A = '11111111-1111-4111-8111-111111111111';
  const SESS_B = '22222222-2222-4222-8222-222222222222';

  it('stops a candidate whose room is NOT live; SPARES one whose room IS live; resets after stop', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [
          { machine_id: A, claimed_session_id: SESS_A, state: 'busy' }, // room dead → reap
          { machine_id: B, claimed_session_id: SESS_B, state: 'busy' }, // room live → spare
        ],
      }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      roomNameForSession: (s) => `room-${s}`,
      roomIsLive: async (room) => room === `room-${SESS_B}`, // only B is live
    }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(1);
    expect(fly.calls).toContain(`stop:${APP}:${A}`);
    expect(fly.calls).not.toContain(`stop:${APP}:${B}`); // spared
    // reset ran for the stopped one only.
    const resets = calls.filter((c) => c.name === 'reset_voice_worker');
    expect(resets).toHaveLength(1);
    expect(resets[0].args.p_machine_id).toBe(A);
  });

  it('reaps a candidate with NO claim (leaked started machine)', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [{ machine_id: A, claimed_session_id: null, state: 'starting' }],
      }],
    });
    const roomIsLive = vi.fn(async () => true);
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc, roomIsLive }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(1);
    expect(fly.calls).toContain(`stop:${APP}:${A}`);
    expect(roomIsLive).not.toHaveBeenCalled(); // no claim → no room check
  });

  it('SPARES a candidate whose room-liveness check THROWS (unknown ≠ dead)', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [{ machine_id: A, claimed_session_id: SESS_A, state: 'busy' }],
      }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      roomIsLive: async () => { throw new Error('livekit down'); },
    }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    expect(fly.calls).not.toContain(`stop:${APP}:${A}`);
  });
});

describe('reapWorkers — T2③ orphan sweep (Fly-started but lease-stopped)', () => {
  const A = 'orphan01'; // a genuine orphan: lease stopped, Fly started
  const B = 'midstart2'; // a machine Fly reports `starting` (a concurrent claim)
  const C = 'agree0033'; // Fly agrees it is stopped (false alarm)

  it('stops a MANAGED pool machine Fly reports `started` while its lease reads stopped', async () => {
    const fly = fakeFly({
      // Fly reports the orphan running, plus an always-on machine NOT in the
      // orphan-candidate list (must be untouched — it has no lease row).
      listMachines: async () => [
        { id: A, state: 'started', raw: {} },
        { id: 'alwayson', state: 'started', raw: {} },
      ],
    });
    const { rpc, calls } = fakeRpc({
      // Normal sweep: nothing.
      list_reapable_voice_workers: [{ data: [] }],
      // Orphan candidates: the pool machine whose lease is stopped + long-idle.
      list_orphaned_voice_worker_leases: [{ data: [{ machine_id: A }] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(1);
    expect(fly.calls).toContain(`stop:${APP}:${A}`);
    // The always-on machine is NOT a candidate (no lease row → never listed), so
    // it is never stopped even though Fly reports it started.
    expect(fly.calls).not.toContain(`stop:${APP}:alwayson`);
    const resets = calls.filter((c) => c.name === 'reset_voice_worker');
    expect(resets).toHaveLength(1);
    expect(resets[0].args.p_machine_id).toBe(A);
  });

  it('race (a): SKIPS a candidate Fly reports `starting` (a concurrent claim mid-boot)', async () => {
    const fly = fakeFly({
      listMachines: async () => [{ id: B, state: 'starting', raw: {} }],
    });
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{ data: [] }],
      list_orphaned_voice_worker_leases: [{ data: [{ machine_id: B }] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    expect(fly.calls).not.toContain(`stop:${APP}:${B}`);
  });

  it('SKIPS a candidate Fly agrees is stopped (the DB was right; false alarm)', async () => {
    const fly = fakeFly({
      listMachines: async () => [{ id: C, state: 'stopped', raw: {} }],
    });
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{ data: [] }],
      list_orphaned_voice_worker_leases: [{ data: [{ machine_id: C }] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    expect(fly.calls).not.toContain(`stop:${APP}:${C}`);
  });

  it('SKIPS a candidate absent from the Fly list (unknown ≠ running)', async () => {
    const fly = fakeFly({ listMachines: async () => [] }); // empty: A not present
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{ data: [] }],
      list_orphaned_voice_worker_leases: [{ data: [{ machine_id: A }] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    expect(fly.calls).not.toContain(`stop:${APP}:${A}`);
  });

  it('SPARES every candidate when the Fly listMachines call THROWS (unknown ≠ dead)', async () => {
    const fly = fakeFly({
      listMachines: async () => { throw new FlyMachinesError('server', { operation: 'listMachines' }); },
    });
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{ data: [] }],
      list_orphaned_voice_worker_leases: [{ data: [{ machine_id: A }] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    expect(fly.calls).not.toContain(`stop:${APP}:${A}`);
  });

  it('an orphan-candidate list error does NOT lose the normal sweep result', async () => {
    // The normal sweep stops one; the orphan candidate RPC then errors. The
    // combined count must still reflect the normal-sweep stop.
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [{ machine_id: 'norm0001', claimed_session_id: null, state: 'starting' }],
      }],
      list_orphaned_voice_worker_leases: [{ error: { message: 'db down' } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client, rpc, roomIsLive: async () => false,
    }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(1); // the normal sweep's stop survived
    expect(fly.calls).toContain(`stop:${APP}:norm0001`);
  });

  it('does not query Fly at all when there are no orphan candidates', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{ data: [] }],
      list_orphaned_voice_worker_leases: [{ data: [] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    // No candidates ⇒ no listMachines call (the SDK stays unloaded on the hot path).
    expect(fly.calls.some((c) => c.startsWith('list:'))).toBe(false);
  });

  it('a stop-failure on one orphan leaves its lease untouched (no reset) and does not count it', async () => {
    const fly = fakeFly({
      listMachines: async () => [{ id: A, state: 'started', raw: {} }],
      stopMachine: async () => { throw new FlyMachinesError('server', { operation: 'stopMachine' }); },
    });
    const { rpc, calls } = fakeRpc({
      list_reapable_voice_workers: [{ data: [] }],
      list_orphaned_voice_worker_leases: [{ data: [{ machine_id: A }] }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    // No reset for a machine we could not confirm stopped.
    expect(calls.some((c) => c.name === 'reset_voice_worker')).toBe(false);
  });
});

describe('disabled flag no-ops every entry point', () => {
  it('ensureReadyWorker → disabled, releaseWorker → noop, reapWorkers → disabled; NO Fly/DB calls', async () => {
    const fly = fakeFly();
    const rpcCalls: string[] = [];
    const rpc: RpcCaller = async (name) => { rpcCalls.push(name); return { data: {}, error: null }; };
    const svc = createWorkerOrchestrationService(baseDeps({ enabled: false, fly: fly.client, rpc }));

    expect(await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION }))
      .toEqual({ status: 'disabled' });
    await svc.releaseWorker({ app: APP, machineId: MACHINE, sessionId: SESSION });
    await svc.releaseWorkerBySession({ app: APP, sessionId: SESSION });
    await svc.markBusy({ app: APP, machineId: MACHINE, sessionId: SESSION, epoch: 1 });
    expect(await svc.releaseTerminalSessions({ app: APP })).toEqual({ released: 0, disabled: true });
    expect(await svc.reapWorkers({ app: APP })).toEqual({ stopped: 0, disabled: true });

    // The new terminal-release + busy entry points are ALSO inert when off:
    // no Fly call, no DB call — proving the flag-off path is byte-identical.
    expect(fly.calls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });
});

describe('reaper runtime gate', () => {
  it('returns null when the flag is off (no scheduler constructed)', () => {
    expect(createWorkerOrchestrationRuntime({ enabled: false })).toBeNull();
  });

  it('constructs a scheduler when enabled, and reaps + terminal-releases both apps on tickAll, release BEFORE reap', async () => {
    // ONE shared ordered log, not two arrays. Two separate arrays each look
    // right even if the two passes are swapped — the reviewer's point. A single
    // interleaved log is the only witness that can catch a swap: if reap ran
    // first for any app, `reap:<app>` would appear before `release:<app>`.
    const log: string[] = [];
    const runtime = createWorkerOrchestrationRuntime({
      enabled: true,
      service: {
        ensureReadyWorker: async () => ({ status: 'disabled' }),
        releaseWorker: async () => {},
        releaseWorkerBySession: async () => {},
        releaseTerminalSessions: async ({ app }) => { log.push(`release:${app}`); return { released: 0 }; },
        markBusy: async () => {},
        reapWorkers: async ({ app }) => { log.push(`reap:${app}`); return { stopped: 0 }; },
      },
      apps: ['app-phone', 'app-browser'],
      // Never arm real timers in the test.
      scheduler: { setTimer: () => ({ unref: () => {} }), clearTimer: () => {} },
    });
    expect(runtime).not.toBeNull();
    await runtime!.tickAll();
    // The exact interleaving: terminal-release runs BEFORE reap so a just-
    // released session is not also reaped the same tick. A swap of the two
    // passes (for either app) would reorder this list and fail.
    expect(log).toEqual([
      'release:app-phone',
      'release:app-browser',
      'reap:app-phone',
      'reap:app-browser',
    ]);
    // Cross-check the invariant directly: every release precedes every reap.
    const lastRelease = log.map((e) => e.startsWith('release:')).lastIndexOf(true);
    const firstReap = log.map((e) => e.startsWith('reap:')).indexOf(true);
    expect(lastRelease).toBeLessThan(firstReap);
    expect(runtime!.loopIntervalsMs).toHaveProperty('worker-orchestration-terminal-release');
    expect(runtime!.loopIntervalsMs).toHaveProperty('worker-orchestration-reap');
    await runtime!.stop();
  });
});
