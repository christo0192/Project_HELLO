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
  /** Candidates returned to the real production reaper. */
  reapRows: [] as Array<{ machine_id: string; claimed_session_id: string | null; state: string }>,
  /** Endpoint and room requested by the lazy LiveKit liveness client. */
  roomLookups: [] as Array<{ url: string; room: string }>,
  /** Fly stop calls made by the real production reaper. */
  stops: [] as string[],
  /** Per-endpoint liveness behavior for the fake LiveKit SDK. */
  listParticipants: new Map<string, (room: string) => Promise<Array<unknown>>>(),
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
        if (name === 'list_reapable_voice_workers') {
          return { data: h.reapRows, error: null };
        }
        if (name === 'list_orphaned_voice_worker_leases') {
          return { data: [], error: null };
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
      async stopMachine(app: string, machineId: string) { h.stops.push(`${app}:${machineId}`); return {}; },
      async listMachines() { return []; },
      async getMachine(_app: string, id: string) { return { id, state: 'started', raw: {} }; },
    }),
  };
});

vi.mock('livekit-server-sdk', () => {
  class RoomServiceClient {
    constructor(private readonly url: string) {}
    async listParticipants(room: string): Promise<Array<unknown>> {
      h.roomLookups.push({ url: this.url, room });
      const handler = h.listParticipants.get(this.url);
      if (!handler) throw new Error(`unexpected endpoint ${this.url}`);
      return handler(room);
    }
  }
  return {
    RoomServiceClient,
    AccessToken: class {},
    AgentDispatchClient: class {},
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
import { createBrowserWorkerOrchestrationService } from '../lib/browser-orchestration.js';
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
  h.reapRows.length = 0;
  h.roomLookups.length = 0;
  h.stops.length = 0;
  h.listParticipants.clear();
  delete process.env.BROWSER_LIVEKIT_TARGET;
  delete process.env.R1_LIVEKIT_URL;
  delete process.env.R1_LIVEKIT_API_KEY;
  delete process.env.R1_LIVEKIT_API_SECRET;
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

describe('production reaper endpoint isolation', () => {
  const BROWSER_APP = 'project-hello-voice';
  const BROWSER_MACHINE = 'browser-machine';

  function reapCandidate(sessionId: string) {
    h.reapRows.push({ machine_id: BROWSER_MACHINE, claimed_session_id: sessionId, state: 'busy' });
  }

  it('spares a browser worker whose room is live on selected R1 even though Cloud lacks it', async () => {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'wss://r1.invalid';
    process.env.R1_LIVEKIT_API_KEY = 'r1-key';
    process.env.R1_LIVEKIT_API_SECRET = 'r1-secret';
    reapCandidate(SESSION);
    h.listParticipants.set('wss://r1.invalid', async () => [{ identity: 'candidate' }]);
    h.listParticipants.set('wss://livekit.invalid', async () => {
      throw Object.assign(new Error('requested room does not exist'), { code: 'not_found' });
    });

    const result = await createBrowserWorkerOrchestrationService().reapWorkers({ app: BROWSER_APP });

    expect(result.stopped).toBe(0);
    expect(h.stops).toEqual([]);
    expect(h.roomLookups).toEqual([{ url: 'wss://r1.invalid', room: `screening-${SESSION}` }]);
  });

  it('keeps the phone reaper on Cloud and stops a Cloud-absent phone room', async () => {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'wss://r1.invalid';
    process.env.R1_LIVEKIT_API_KEY = 'r1-key';
    process.env.R1_LIVEKIT_API_SECRET = 'r1-secret';
    reapCandidate(SESSION);
    h.listParticipants.set('wss://livekit.invalid', async () => {
      throw Object.assign(new Error('requested room does not exist'), { code: 'not_found' });
    });

    const result = await createDefaultWorkerOrchestrationService().reapWorkers({ app: APP });

    expect(result.stopped).toBe(1);
    expect(h.stops).toEqual([`${APP}:${BROWSER_MACHINE}`]);
    expect(h.roomLookups).toEqual([{ url: 'wss://livekit.invalid', room: `phone-${SESSION}` }]);
  });
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

// ── 0118 (PR-LK-liveness): `livekit_host` is an R1-browser-only column ──────
// Every test above this block is byte-identical to origin/main. The phone lease
// reader and the Cloud-browser lease reader must keep the exact pre-0118 select
// string — so neither lane's readiness depends on migration 0118 — and neither
// may surface a host. Only the R1-target browser service selects and surfaces it.
describe('lease host column (0118) is R1-browser-only', () => {
  const PRE_0118_SELECT = 'state, claimed_session_id, epoch, registered_agent_name';
  const BROWSER_APP_NAME = 'project-hello-voice';

  function selectR1(): void {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'wss://r1.invalid';
    process.env.R1_LIVEKIT_API_KEY = 'r1-key';
    process.env.R1_LIVEKIT_API_SECRET = 'r1-secret';
  }

  function ensureBrowser(service: ReturnType<typeof createDefaultWorkerOrchestrationService>) {
    return service.ensureReadyWorker({
      app: BROWSER_APP_NAME,
      pipeline: 'browser',
      sessionId: SESSION,
      epoch: 1,
      readyTimeoutSec: 30,
    });
  }

  it('the phone reader selects exactly the pre-0118 columns and never livekit_host', async () => {
    h.row = readyRow({ registered_agent_name: PER_MACHINE, livekit_host: 'r1.example.test' });
    await gate();
    expect(h.selects.length).toBeGreaterThan(0);
    for (const cols of h.selects) {
      expect(cols).toBe(PRE_0118_SELECT);
      expect(cols).not.toContain('livekit_host');
    }
  });

  it('the phone verdict never carries livekitHost, even when the row has one', async () => {
    h.row = readyRow({ registered_agent_name: PER_MACHINE, livekit_host: 'r1.example.test' });
    const res = await gate();
    expect(res).toEqual({ status: 'ready', machineId: MACHINE, epoch: LEASE_EPOCH, agentName: PER_MACHINE });
    expect(res).not.toHaveProperty('livekitHost');
  });

  it('a phone-pipeline request never surfaces a host, even from a reader that selected it', async () => {
    h.row = readyRow({ registered_agent_name: PER_MACHINE, livekit_host: 'r1.example.test' });
    const res = await createDefaultWorkerOrchestrationService({ readLivekitHost: true }).ensureReadyWorker({
      app: APP, pipeline: 'phone', sessionId: SESSION, epoch: 1, readyTimeoutSec: 30,
    });
    expect(res).not.toHaveProperty('livekitHost');
  });

  it('the Cloud browser reader keeps the pre-0118 select and a verdict with no livekitHost key', async () => {
    h.row = readyRow({ registered_agent_name: null, livekit_host: 'r1.example.test' });
    const res = await ensureBrowser(createBrowserWorkerOrchestrationService());
    expect(res).toEqual({ status: 'ready', machineId: MACHINE, epoch: LEASE_EPOCH, agentName: null });
    expect(res).not.toHaveProperty('livekitHost');
    for (const cols of h.selects) expect(cols).toBe(PRE_0118_SELECT);
  });

  it('only the R1-target browser reader selects livekit_host and surfaces it on the verdict', async () => {
    selectR1();
    h.row = readyRow({ registered_agent_name: null, livekit_host: 'r1.example.test' });
    const res = await ensureBrowser(createBrowserWorkerOrchestrationService());
    expect(res).toEqual({
      status: 'ready', machineId: MACHINE, epoch: LEASE_EPOCH, agentName: null,
      livekitHost: 'r1.example.test',
    });
    expect(h.selects.length).toBeGreaterThan(0);
    for (const cols of h.selects) {
      expect(cols).toBe(`${PRE_0118_SELECT}, livekit_host`);
    }
  });

  for (const [label, value] of [
    ['null', null],
    ['absent', undefined],
    ['a number', 42],
    ['an object', { host: 'r1.example.test' }],
  ] as const) {
    it(`the R1 browser reader reads a ${label} lease host as null (the host match then refuses it)`, async () => {
      selectR1();
      h.row = readyRow(value === undefined ? {} : { livekit_host: value });
      const res = await ensureBrowser(createBrowserWorkerOrchestrationService());
      expect(res).toMatchObject({ status: 'ready', livekitHost: null });
    });
  }

  it('explicit opt-out keeps the default reader on the pre-0118 select', async () => {
    h.row = readyRow({ livekit_host: 'r1.example.test' });
    const res = await createDefaultWorkerOrchestrationService({ readLivekitHost: false }).ensureReadyWorker({
      app: APP, pipeline: 'phone', sessionId: SESSION, epoch: 1, readyTimeoutSec: 30,
    });
    expect(res).not.toHaveProperty('livekitHost');
    for (const cols of h.selects) expect(cols).toBe(PRE_0118_SELECT);
  });
});
