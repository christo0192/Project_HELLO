/**
 * Queue runner fairness — a backlogged queue must not starve its siblings.
 *
 * PRODUCTION INCIDENT (2026-09-16). One runner serves `ashby.signal`,
 * `ashby.import` and `ashby.ingestion` with `concurrency: 2`. An external bulk
 * stage-move buried `ashby.signal` under thousands of jobs. `ashby.import` held
 * exactly two jobs — two candidates an owner had just moved into the screening
 * stage — and they were never claimed: `attempts` stayed 0 for hours while the
 * logs showed an unbroken stream of `ashby.signal` claims and completions.
 *
 * The mechanism was iteration order. `queueNames` came from
 * `Object.keys(handlers)`, `ashby.signal` is declared first, `active` is
 * incremented at CLAIM and decremented only when a job SETTLES, and the loop
 * does not await settlement. So the first queue consumed the whole budget every
 * tick and, by the time the loop reached the second queue, `active < concurrency`
 * was already false — no claim, no event, no error, nothing to alert on.
 *
 * Three properties are pinned here, because the first two fixes attempted were
 * each individually insufficient and adversarial review caught both:
 *
 *   1. ROTATION — first pick moves between queues.
 *   2. THE PRIVILEGE IS ONLY SPENT WHEN USED — a tick that claimed nothing
 *      because the budget was full, or whose first-pick queue the admission
 *      gate refused, must NOT consume that queue's turn. Advancing the cursor
 *      unconditionally lets handler duration resonate with the tick interval
 *      and reproduces the original starvation exactly.
 *   3. PER-QUEUE CAP — rotation alone is winner-take-all: the first-pick queue
 *      can still absorb the whole budget on its turn. Capping one queue's
 *      claims per tick means a second queue is served on EVERY tick.
 *
 * The tests deliberately hold jobs in flight ACROSS tick boundaries, because
 * draining between ticks tests only the easy regime in which every candidate
 * fix already works.
 */

import { describe, it, expect } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner } from '../lib/queue/runner.js';

/**
 * Drain microtasks until `pred` holds. THROWS on exhaustion: a silent return
 * would turn "the work never happened" into a confusing failure in whichever
 * assertion came next, pointing nowhere near the cause.
 */
async function until(pred: () => boolean, turns = 1000): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await Promise.resolve();
  if (!pred()) throw new Error(`until() exhausted after ${turns} microtask turns`);
}

function makeQueue(nowIso = '2026-09-16T00:00:00.000Z'): Queue {
  let current = nowIso;
  const clock = (): string => current;
  return new Queue(new MemoryAdapter({ clock }), { clock });
}

/** A promise whose resolution this test controls. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = () => resolve(); });
  return { wait, open };
}

describe('createQueueRunner — a backlogged queue must not starve its siblings', () => {
  it('serves the starved queue on the very next tick, holding the storm in flight', async () => {
    const queue = makeQueue();
    for (let i = 0; i < 50; i++) await queue.enqueue('q.signal', { i });
    await queue.enqueue('q.import', { app: 'a' });

    const importSeen: string[] = [];
    const held = gate();

    const runner = createQueueRunner({
      queue,
      // Declaration order matters: `q.signal` FIRST reproduces production.
      handlers: {
        'q.signal': async () => { await held.wait; },
        'q.import': async (job) => { importSeen.push((job.payload as { app: string }).app); },
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
    });

    // One tick. The signal queue is first and permanently backlogged, but the
    // per-queue cap leaves a slot, so the import job is claimed in the SAME
    // pass — never mind a later one.
    await runner.tick();
    await until(() => importSeen.length >= 1);

    held.open();
    await runner.stop();
    expect(importSeen).toEqual(['a']);
  });

  it('does NOT spend the rotation on a tick whose budget was already full', async () => {
    // The resonance case: handler duration straddling tick boundaries. If the
    // cursor advances on a tick that claimed nothing, first pick can land back
    // on the storm queue every time and the starvation survives the fix.
    const queue = makeQueue();
    for (let i = 0; i < 50; i++) await queue.enqueue('q.signal', { i });
    await queue.enqueue('q.second', { n: 1 });

    const claims: string[] = [];
    const held = gate();

    const runner = createQueueRunner({
      queue,
      handlers: {
        'q.signal': async () => { await held.wait; },
        'q.second': async () => { await held.wait; },
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 1,
      onEvent: (e) => { if (e.kind === 'claimed') claims.push(e.queueName); },
    });

    // Tick 1 — concurrency 1, so the single slot goes to first pick (signal)
    // and is then HELD. The rotation was used, so it advances to q.second.
    await runner.tick();
    await until(() => claims.length >= 1);
    expect(claims).toEqual(['q.signal']);

    // Tick 2 claims nothing at all: the budget is still occupied. It must NOT
    // burn q.second's turn.
    //
    // Exactly ONE blocked tick is the sharp case. With two queues, spending the
    // turn on two consecutive blocked ticks would wrap the cursor back to
    // q.second by coincidence and the bug would hide; with one, an
    // unconditional spend lands first pick back on q.signal and q.second is
    // passed over again — the resonance that reproduces the incident.
    await runner.tick();
    expect(claims).toEqual(['q.signal']);

    // Free the budget. The next tick must hand the slot to q.second — the turn
    // was parked, not consumed.
    held.open();
    await until(() => runner.inFlight() === 0);
    await runner.tick();
    await until(() => claims.length >= 2);
    await runner.stop();

    expect(claims[1]).toBe('q.second');
  });

  it('does NOT spend the rotation when the admission gate refuses first pick', async () => {
    // Production wires `shouldClaim` and refuses `ashby.ingestion` whenever the
    // malware scanner is not ready. A refused queue that still burned its turn
    // would hand the extra turns straight back to the storm queue.
    const queue = makeQueue();
    for (let i = 0; i < 20; i++) {
      await queue.enqueue('q.a', { i });
      await queue.enqueue('q.blocked', { i });
    }

    const claims: string[] = [];
    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => {}, 'q.blocked': async () => {} },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 1,
      shouldClaim: async (name) => name !== 'q.blocked',
      onEvent: (e) => { if (e.kind === 'claimed') claims.push(e.queueName); },
    });

    for (let t = 0; t < 4; t++) {
      await runner.tick();
      await until(() => runner.inFlight() === 0);
    }
    await runner.stop();

    // Every claim is q.a (q.blocked is refused), and crucially the runner kept
    // working rather than wedging on the refused queue's parked turn.
    expect(claims.length).toBe(4);
    expect(claims.every((c) => c === 'q.a')).toBe(true);
  });

  it('keeps rotating when the FIRST-PICK queue is permanently gate-refused', async () => {
    // THREE queues, because at two the pinned-cursor bug is observationally
    // inert: the only other queue receives everything either way.
    //
    // Production shape: `ashby.ingestion` is the sole gated queue and its
    // scanner outage is budgeted at eight hours. If a refusal parked the turn,
    // the cursor would pin to it, the order would freeze as
    // [ingestion, signal, import], and every contested slot would go back to
    // the storm queue — the original incident, rebuilt by its own fix.
    const queue = makeQueue();
    for (let i = 0; i < 20; i++) {
      await queue.enqueue('q.gated', { i });
      await queue.enqueue('q.storm', { i });
      await queue.enqueue('q.small', { i });
    }

    const firstClaimPerTick: string[] = [];
    let tickStarted = false;

    const runner = createQueueRunner({
      queue,
      // q.gated FIRST, mirroring a refused queue holding the initial cursor.
      handlers: {
        'q.gated': async () => {}, 'q.storm': async () => {}, 'q.small': async () => {},
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 1,
      shouldClaim: async (name) => name !== 'q.gated',
      onEvent: (e) => {
        if (e.kind === 'claimed' && tickStarted) {
          firstClaimPerTick.push(e.queueName);
          tickStarted = false;
        }
      },
    });

    for (let t = 0; t < 4; t++) {
      tickStarted = true;
      await runner.tick();
      await until(() => runner.inFlight() === 0);
    }
    await runner.stop();

    // q.small must get first pick despite q.gated holding the initial cursor.
    // A parked refusal pins the cursor and q.storm takes every tick.
    expect(firstClaimPerTick).toContain('q.small');
  });

  it('offers the leftover slot to a SIBLING before the queue that already had its share', async () => {
    // The leftover pass must not start at the first-pick queue: a slot freed
    // mid-tick (often by its own handler settling) would go back to it,
    // spending a turn that was parked. In production a signal handler ENQUEUES
    // an import job, so sibling work routinely appears between the passes.
    const queue = makeQueue();
    for (let i = 0; i < 10; i++) await queue.enqueue('q.first', { i });
    for (let i = 0; i < 10; i++) await queue.enqueue('q.sibling', { i });

    const claims: string[] = [];
    const held = gate();
    const runner = createQueueRunner({
      queue,
      handlers: {
        'q.first': async () => { await held.wait; },
        'q.sibling': async () => { await held.wait; },
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 3,
      onEvent: (e) => { if (e.kind === 'claimed') claims.push(e.queueName); },
    });

    const processed = await runner.tick();
    await until(() => claims.length >= 3);
    held.open();
    await runner.stop();

    // cap = 2, so pass 1 gives q.first 2 and q.sibling 1 → budget full at 3.
    expect(processed).toBe(3);
    expect(claims.filter((c) => c === 'q.sibling').length).toBeGreaterThanOrEqual(1);
  });

  it('counts leftover-pass claims in the tick result, which drives the poll backoff', async () => {
    // `queueRunnerTick` returns `processed > 0`; a tick whose only claims came
    // from the leftover pass reporting 0 would let `nextPollDelayMs` back the
    // loop off geometrically WHILE a queue is backlogged.
    const queue = makeQueue();
    await queue.enqueue('q.only', { n: 1 });
    await queue.enqueue('q.only', { n: 2 });
    const held = gate();
    const runner = createQueueRunner({
      queue,
      handlers: { 'q.only': async () => { await held.wait; }, 'q.idle': async () => {} },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
    });
    const processed = await runner.tick();
    held.open();
    await runner.stop();
    // 1 from the capped pass + 1 from the leftover pass.
    expect(processed).toBe(2);
  });

  it('asks the admission gate once per queue per TICK, not once per runner', async () => {
    // A runner-lifetime cache would latch a refused queue as refused forever —
    // ingestion would never resume after the scanner recovered, silently.
    const queue = makeQueue();
    for (let i = 0; i < 6; i++) await queue.enqueue('q.a', { i });
    let gateCalls = 0;
    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => {}, 'q.b': async () => {} },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
      shouldClaim: async () => { gateCalls += 1; return true; },
    });
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    expect(gateCalls).toBe(2);
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();
    // Re-asked on the second tick: 2 queues x 2 ticks.
    expect(gateCalls).toBe(4);
  });

  it('does not retry a queue whose claim already errored this tick', async () => {
    // On a DB fault every claim throws; retrying in the leftover pass would
    // double both the load on a failing database and the poll_error rate an
    // operator is reading at that moment.
    const errors: string[] = [];
    const failing = {
      claim: async () => { throw new Error('db_down'); },
    } as unknown as Queue;
    const runner = createQueueRunner({
      queue: failing,
      handlers: { 'q.a': async () => {}, 'q.b': async () => {} },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
      onEvent: (e) => { if (e.kind === 'poll_error') errors.push(e.queueName); },
    });
    await runner.tick();
    await runner.stop();
    // One error per queue, not two.
    expect(errors).toEqual(['q.a', 'q.b']);
  });

  it('caps one queue so it cannot take the whole budget while siblings wait', async () => {
    const queue = makeQueue();
    for (let i = 0; i < 10; i++) await queue.enqueue('q.hog', { i });
    for (let i = 0; i < 10; i++) await queue.enqueue('q.small', { i });

    const claims: string[] = [];
    const held = gate();
    const runner = createQueueRunner({
      queue,
      handlers: {
        'q.hog': async () => { await held.wait; },
        'q.small': async () => { await held.wait; },
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
      onEvent: (e) => { if (e.kind === 'claimed') claims.push(e.queueName); },
    });

    await runner.tick();
    await until(() => claims.length >= 2);
    held.open();
    await runner.stop();

    // Two slots, two queues — one each, not both to the first queue.
    expect(claims.length).toBe(2);
    expect(new Set(claims)).toEqual(new Set(['q.hog', 'q.small']));
  });

  it('gives the leftover budget back, so the cap reserves without throttling', async () => {
    // The cap must not cost throughput when there is nothing to be fair to.
    // A tick claims at most its budget and returns, so a slot left unused is
    // throughput permanently lost — at a 5s poll that would have HALVED the
    // hot queue's drain rate and made the storm worse, not better.
    const queue = makeQueue();
    for (let i = 0; i < 10; i++) await queue.enqueue('q.busy', { i });
    // q.idle is registered but empty — its reserved slot must not be wasted.
    const held = gate();
    const claims: string[] = [];

    const runner = createQueueRunner({
      queue,
      handlers: {
        'q.busy': async () => { await held.wait; },
        'q.idle': async () => { await held.wait; },
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
      onEvent: (e) => { if (e.kind === 'claimed') claims.push(e.queueName); },
    });

    await runner.tick();
    await until(() => claims.length >= 2);
    held.open();
    await runner.stop();

    // Both slots went to the only queue with work.
    expect(claims).toEqual(['q.busy', 'q.busy']);
  });

  it('still refuses a gate-blocked queue during the leftover pass', async () => {
    const queue = makeQueue();
    for (let i = 0; i < 10; i++) await queue.enqueue('q.blocked', { i });
    const claims: string[] = [];
    let gateCalls = 0;

    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => {}, 'q.blocked': async () => {} },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
      shouldClaim: async (name) => { gateCalls += 1; return name !== 'q.blocked'; },
      onEvent: (e) => { if (e.kind === 'claimed') claims.push(e.queueName); },
    });

    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();

    // The refused queue stays refused even with budget going spare...
    expect(claims).toEqual([]);
    // ...and the gate is asked once per queue per tick, not once per pass.
    expect(gateCalls).toBe(2);
  });

  it('rotates first pick in order across ticks', async () => {
    const queue = makeQueue();
    for (let i = 0; i < 20; i++) {
      await queue.enqueue('q.a', { i });
      await queue.enqueue('q.b', { i });
      await queue.enqueue('q.c', { i });
    }

    const firstClaimPerTick: string[] = [];
    let tickStarted = false;

    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => {}, 'q.b': async () => {}, 'q.c': async () => {} },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 1,
      onEvent: (e) => {
        if (e.kind === 'claimed' && tickStarted) {
          firstClaimPerTick.push(e.queueName);
          tickStarted = false;
        }
      },
    });

    for (let t = 0; t < 3; t++) {
      tickStarted = true;
      await runner.tick();
      await until(() => runner.inFlight() === 0);
    }
    await runner.stop();

    // Exact order, not merely distinctness: a random or reversed pick would
    // satisfy a set comparison while breaking the documented contract.
    expect(firstClaimPerTick).toEqual(['q.a', 'q.b', 'q.c']);
  });

  it('keeps the whole budget for a single-queue runner', async () => {
    const queue = makeQueue();
    await queue.enqueue('q.only', { n: 1 });
    await queue.enqueue('q.only', { n: 2 });
    const seen: number[] = [];
    const held = gate();

    const runner = createQueueRunner({
      queue,
      handlers: {
        'q.only': async (job) => { seen.push((job.payload as { n: number }).n); await held.wait; },
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
    });

    // With nothing to be fair to, the cap must not halve throughput: both
    // slots go to the only queue in ONE tick.
    await runner.tick();
    await until(() => seen.length >= 2);
    held.open();
    await runner.stop();
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('tolerates a runner with no registered queues', async () => {
    // Not a starvation guard — just proof the rotation arithmetic cannot be
    // reached with a zero divisor.
    const queue = makeQueue();
    const runner = createQueueRunner({
      queue, handlers: {}, owner: 'w1', leaseSeconds: 30, pollMs: 1000, concurrency: 2,
    });
    expect(await runner.tick()).toBe(0);
    expect(await runner.tick()).toBe(0);
    await runner.stop();
  });
});
