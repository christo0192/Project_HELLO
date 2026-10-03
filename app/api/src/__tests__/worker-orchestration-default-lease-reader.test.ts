/**
 * M009 E2 — the PRODUCTION lease reader inside
 * `createDefaultWorkerOrchestrationService` is the only link between the
 * 0112 `voice_worker_leases.registered_agent_name` column and the targeted
 * dispatch. Every other suite reaches `ensureReadyWorker` through an injected
 * reader fake, so a typo in the select string or a dropped field in the row
 * mapping would leave `agentName` null for ever with every unit suite green —
 * and once the worker flag is on, the dial would take the UNTARGETED path and
 * dispatch the shared name no worker serves.
 *
 * This suite drives the real default factory end to end (claim → start →
 * ready read) over a fake service-role client and a fake Fly client, and pins:
 *   (a) the lease select names `registered_agent_name`;
 *   (b) a string value comes back as `gate.agentName` (with the lease epoch);
 *   (c) null / non-string values come back as null (dispatch the shared name).
 *
 * Machine ids are synthetic Fly-shaped ids; no candidate data appears.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  /** The row the lease read returns. */
  row: null as Record<string, unknown> | null,
  /** Every `.select(...)` string issued against voice_worker_leases. */
  selects: [] as string[],
  /** Every `.from(...)` table name. */
  tables: [] as string[],
  /** Every `.eq(col, val)` filter, as 'col=val'. */
  filters: [] as string[],
}));

vi.mock('../lib/env.js', () => ({
  env: {
    workerOrchestration: true,
    flyApiToken: 'fly-test-token',
    flyApiBaseUrl: 'https://fly.invalid/v1',
    livekitUrl: 'wss://livekit.invalid',
    livekitApiKey: 'k',
    livekitApiSecret: 's',
  },
}));

vi.mock('../lib/supabase.js', () => {
  const query = {
    select(cols: string) {
      h.selects.push(cols);
      return query;
    },
    eq(col: string, val: unknown) {
      h.filters.push(`${col}=${String(val)}`);
      return query;
    },
    async maybeSingle() {
      return { data: h.row, error: null };
    },
  };
  return {
    supabase: {
      from(table: string) {
        h.tables.push(table);
        return query;
      },
      async rpc(name: string) {
        if (name === 'claim_voice_worker') {
          return { data: { status: 'claimed', machine_id: 'd895472c499e38', epoch: 23 }, error: null };
        }
        return { data: { status: 'ok' }, error: null };
      },
    },
  };
});

vi.mock('../lib/fly-machines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/fly-machines.js')>();
  return {
    ...actual,
    createFlyMachinesClient: () => ({
      async startMachine() { return {}; },
      async waitForState() { return {}; },
      async stopMachine() { return {}; },
      async listMachines() { return []; },
      async getMachine(_app: string, id: string) { return { id, state: 'started', raw: {} }; },
    }),
  };
});

const APP = 'project-hello-phone-voice';
const SESSION = '33333333-3333-4333-8333-333333333333';
const MACHINE = 'd895472c499e38';
const LEASE_EPOCH = 23;
const PER_MACHINE = `phone-screener-${MACHINE}`;

import {
  DEFAULT_START_WAIT_SEC,
  MAX_READY_TIMEOUT_MS,
  createDefaultWorkerOrchestrationService,
} from '../lib/worker-orchestration.js';
import {
  PHONE_WORKER_GATE_CEILING_SEC,
  PHONE_WORKER_READY_CEILING_SEC,
  PHONE_WORKER_START_WAIT_CEILING_SEC,
} from '../integrations/livekit-phone-dial/dial.js';

function readyRow(over: Record<string, unknown>): Record<string, unknown> {
  return { state: 'ready', claimed_session_id: SESSION, epoch: LEASE_EPOCH, ...over };
}

async function gate() {
  return createDefaultWorkerOrchestrationService().ensureReadyWorker({
    app: APP,
    pipeline: 'phone',
    sessionId: SESSION,
    epoch: 1,
    readyTimeoutSec: 30,
  });
}

beforeEach(() => {
  h.row = null;
  h.selects.length = 0;
  h.tables.length = 0;
  h.filters.length = 0;
});

describe('createDefaultWorkerOrchestrationService — production lease reader (M009 E2)', () => {
  it('(a) selects registered_agent_name from voice_worker_leases, keyed by (app, machine_id)', async () => {
    h.row = readyRow({ registered_agent_name: PER_MACHINE });
    await gate();
    expect(h.tables).toContain('voice_worker_leases');
    expect(h.selects.length).toBeGreaterThan(0);
    for (const cols of h.selects) {
      const names = cols.split(',').map((c) => c.trim());
      expect(names).toEqual(
        expect.arrayContaining(['state', 'claimed_session_id', 'epoch', 'registered_agent_name']),
      );
    }
    expect(h.filters).toEqual(expect.arrayContaining([`app=${APP}`, `machine_id=${MACHINE}`]));
  });

  it('(b) a reported per-machine name reaches the gate verdict as agentName, with the LEASE epoch', async () => {
    h.row = readyRow({ registered_agent_name: PER_MACHINE });
    const res = await gate();
    expect(res).toEqual({ status: 'ready', machineId: MACHINE, epoch: LEASE_EPOCH, agentName: PER_MACHINE });
  });

  it('(b) a bigint epoch handed back as a digit string still reaches the verdict as a number', async () => {
    h.row = readyRow({ epoch: String(LEASE_EPOCH), registered_agent_name: PER_MACHINE });
    const res = await gate();
    expect(res).toMatchObject({ status: 'ready', epoch: LEASE_EPOCH, agentName: PER_MACHINE });
  });

  for (const [label, value] of [
    ['null', null],
    ['absent', undefined],
    ['a number', 42],
    ['an object', { name: PER_MACHINE }],
  ] as const) {
    it(`(c) registered_agent_name ${label} ⇒ agentName null (dispatch the shared name)`, async () => {
      h.row = readyRow(value === undefined ? {} : { registered_agent_name: value });
      const res = await gate();
      expect(res).toMatchObject({ status: 'ready', machineId: MACHINE });
      expect((res as { agentName?: unknown }).agentName).toBeNull();
    });
  }
});

// dial.ts sizes the agent-join budget against copies of the service's private
// bounds (it does not import this module, which pulls env and Fly wiring). If
// either source bound moves, the copies must move with it, or a slow gate plus
// the join can overrun the admission lease again.
describe('phone dial gate ceilings match the orchestration service bounds', () => {
  it('PHONE_WORKER_READY_CEILING_SEC is MAX_READY_TIMEOUT_MS', () => {
    expect(PHONE_WORKER_READY_CEILING_SEC * 1000).toBe(MAX_READY_TIMEOUT_MS);
  });

  it('PHONE_WORKER_START_WAIT_CEILING_SEC is DEFAULT_START_WAIT_SEC', () => {
    expect(PHONE_WORKER_START_WAIT_CEILING_SEC).toBe(DEFAULT_START_WAIT_SEC);
  });

  it('the gate ceiling is the start wait plus the ready ceiling', () => {
    expect(PHONE_WORKER_GATE_CEILING_SEC).toBe(DEFAULT_START_WAIT_SEC + MAX_READY_TIMEOUT_MS / 1000);
  });
});
