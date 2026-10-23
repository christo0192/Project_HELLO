/**
 * M019 (PR #378): a concurrent-call SIMULATION of up to 15 live R1 browser interviews.
 *
 * Many candidates hit the REAL Express routes at once (`Promise.all`), and every layer between the
 * candidate and the machine that runs the interview is the production code:
 *
 *   POST /api/r1/attempts and /exchange   routes/r1-candidate.ts (real router)
 *   the worker gate                        lib/r1/worker-gate.ts (real)
 *   the browser gate + per-machine names   lib/browser-orchestration.ts (real `browserOrchestrationGate`)
 *   lease claim / poll / release / reap    lib/worker-orchestration.ts (real service)
 *   the worker's readiness ping            routes/voice-worker.ts POST /ready-machine (real router)
 *   the settings interlock                 routes/r1.ts PUT /admin/r1/settings (real router)
 *   the orphan lapse                       lib/r1/orphan-lapse.ts (real)
 *   the scoring runner                     lib/r1/runtime.ts (real, R1_ASSESSMENT_CONCURRENCY)
 *
 * Only the edges are simulated, each mirroring its documented contract:
 *
 *   - admission: the shared R1 candidate harness (`rpcDoubles`, which mirrors 0131's limit,
 *     `round_live` and the single settings-row lock: the double runs to completion without an
 *     await, exactly as racing admissions serialize on `for update` of the settings row);
 *   - the lease table: an in-memory `voice_worker_leases` with the RPCs of 0079/0080/0083/0112/
 *     0118/0131 (claim's idempotent branch and least-recently-stopped order, the release CAS, the
 *     0112 "name must end in -<machine id>" check, retire only a stopped row) — the SAME rows the
 *     admission double counts as the browser pool;
 *   - Fly: start/stop machines; starting one boots a simulated worker that registers with LiveKit
 *     under the name agent.py's `browser_registered_agent_name()` would choose, and posts the body
 *     `_post_browser_machine_ready_after_registration` would post, through the real route;
 *   - LiveKit: a dispatch store. A dispatch to name N is accepted by an IDLE worker registered under
 *     EXACTLY N (one job per machine, the M019 load gate), or by nobody;
 *   - the candidate's camera/mic, the interview itself and its terminal write: the session row is
 *     set `completed` directly, as the worker's terminal write would leave it.
 *
 * NOT simulated (and so not proven here): real Postgres locking (pinned by
 * app/supabase/tests/r1_foundation_assert.sql), real LiveKit scheduling, real Fly boot timing, the
 * Python worker process itself (pinned by app/voice-livekit/tests/test_browser_agent_name.py).
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  db: { current: null as any },
  startRecording: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (table: string) => mocks.db.current.from(table),
    rpc: (fn: string, args: unknown) => mocks.db.current.rpc(fn, args),
  },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('../lib/recording-egress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/recording-egress.js')>()),
  startAuthoritativeRecording: mocks.startRecording,
}));

import { env, r1AssessmentConcurrencyFrom } from '../lib/env.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import {
  browserOrchestrationGate,
  type BrowserAgentDispatchClientLike,
  type BrowserWorkerGate,
} from '../lib/browser-orchestration.js';
import {
  createWorkerOrchestrationService,
  type LeaseStateSnapshot,
  type RpcCaller,
  type WorkerOrchestrationService,
} from '../lib/worker-orchestration.js';
import { BROWSER_FLY_APP } from '../lib/worker-orchestration-runtime.js';
import { roomNameForSession } from '../lib/room-provisioning.js';
import type { DispatchLike, DispatchListerLike } from '../lib/r1/worker-gate.js';
import { createVoiceWorkerRouter } from '../routes/voice-worker.js';
import { r1Router } from '../routes/r1.js';
import { lapseOrphanedR1Sessions } from '../lib/r1/orphan-lapse.js';
import { createR1Runtime } from '../lib/r1/runtime.js';
import { R1_ASSESSMENT_QUEUE } from '../lib/r1/assessment-handler.js';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { R1_METRICS } from '../lib/r1/rubric.js';
import {
  NOW,
  REQUIRED,
  ROLE,
  TEMPLATE,
  WORKER_SECRET,
  buildHarness,
  seedTables,
  type Harness,
} from './support/r1-candidate-harness.js';
import type { Row, Tables } from './support/r1-candidate-fake-db.js';
import {
  baseTables as scorerBaseTables,
  createFakeDb as createR1FakeDb,
} from './support/r1-fake-db.js';
import { cleanLogRows, interviewRows, modelAnswer } from './support/r1-scorer.js';

// ── Constants ───────────────────────────────────────────────────────────────

const BASE = 'browser-screener';
const APP = BROWSER_FLY_APP;
const R1_URL = 'wss://r1.example.test';
const R1_HOST = 'r1.example.test';
const OWNER = '40000000-0000-4000-8000-0000000000f1';
const LIVE = ['created', 'waiting', 'in_progress'];
const TERMINAL = ['completed', 'failed', 'expired', 'cancelled', 'no_answer', 'abandoned'];

/** A Fly machine id of the per-machine suffix class (`^[0-9a-z]{8,32}$`). */
const machineId = (n: number): string => `d8e${String(n).padStart(11, '0')}`;
const roundId = (n: number): string => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const candidateId = (n: number): string => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf-8').digest('hex');
const linkOf = (n: number): string => sha256(`r1-simulated-link-${n}`);

const ENV_KEYS = [
  'R1_ENABLED', 'WORKER_CONTEXT_SECRET', 'BROWSER_LIVEKIT_TARGET',
  'R1_LIVEKIT_URL', 'R1_LIVEKIT_API_KEY', 'R1_LIVEKIT_API_SECRET',
];
const savedEnv: Record<string, string | undefined> = {};
const savedRequire = env.browserRequireMachineAgentName;
const savedScoring = env.r1AssessmentConcurrency;
let audits: AuditEntry[];
let originalSink: ReturnType<typeof getAuditSink>;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.R1_ENABLED = 'true';
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  delete process.env.BROWSER_LIVEKIT_TARGET;
  mocks.startRecording.mockReset();
  mocks.startRecording.mockResolvedValue({ status: 'started', egressId: 'egress-must-not-happen' });
  audits = [];
  originalSink = getAuditSink();
  setAuditSink((entry) => {
    audits.push(entry);
  });
});

afterEach(() => {
  setAuditSink(originalSink);
  env.browserRequireMachineAgentName = savedRequire;
  env.r1AssessmentConcurrency = savedScoring;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ── The simulated world ─────────────────────────────────────────────────────

interface SimOptions {
  target?: 'r1' | 'cloud';
  machines?: number;
  /** r1_settings.max_concurrent_sessions. */
  maxConcurrent?: number;
  candidates?: number;
  /** Worker side: BROWSER_PER_MACHINE_AGENT_NAME=true (agent.py; only takes effect on R1). */
  perMachineNames?: boolean;
  /** API side: BROWSER_REQUIRE_MACHINE_AGENT_NAME. */
  requireNames?: boolean;
  /**
   * A misbehaving boot of one machine: the name its worker registers with LiveKit and the
   * `agent_name` it reports (undefined = reports none). Undefined = a correct boot.
   */
  misboot?: (id: string) => { registers: string; reports?: string } | undefined;
  /**
   * NOT reachable through the ready route (0112 refuses a name that does not end in
   * -<machine id>): overwrite a lease's stored name after its ping, as a hand-edited or drifted
   * row would carry. Pins the gate's own exact-match check (defence in depth).
   */
  corruptStoredName?: (id: string) => string | undefined;
}

interface SimWorker { machineId: string; name: string; job: { room: string; dispatchId: string } | null }
interface SimDispatch {
  id: string;
  room: string;
  agentName: string;
  state: { jobs: Array<{ id: string; state: { status: number; endedAt?: bigint } }>; createdAt: bigint };
}

type Sim = ReturnType<typeof buildSim>;

function buildSim(opts: SimOptions = {}) {
  const target = opts.target ?? 'r1';
  const machines = opts.machines ?? 15;
  const candidates = opts.candidates ?? 16;
  const requireNames = opts.requireNames ?? true;
  // agent.py: per-machine registration is bounded by the R1 readiness switch, so the Cloud lane
  // always registers the shared name even with BROWSER_PER_MACHINE_AGENT_NAME set.
  const workerPerMachine = (opts.perMachineNames ?? true) && target === 'r1';

  if (target === 'r1') {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = R1_URL;
    process.env.R1_LIVEKIT_API_KEY = 'r1-test-key';
    process.env.R1_LIVEKIT_API_SECRET = 's'.repeat(32);
  } else {
    delete process.env.BROWSER_LIVEKIT_TARGET;
  }
  env.browserRequireMachineAgentName = requireNames;

  // ── Tables: N candidates, each with their own round, link and live consent. ──
  const tables: Tables = seedTables();
  tables.interview_rounds = [];
  tables.candidates = [];
  tables.interview_round_consents = [];
  for (let n = 1; n <= candidates; n += 1) {
    tables.interview_rounds.push({
      id: roundId(n),
      candidate_id: candidateId(n),
      role_id: ROLE,
      status: 'invited',
      expires_at: new Date(NOW + 72 * 3600_000).toISOString(),
      attempts_allowed: 2,
      attempts_counted: 0,
      starts_used: 0,
      consent_locale: 'en-IN',
      link_token_digest: sha256(linkOf(n)),
    });
    tables.candidates.push({ id: candidateId(n), name: `Candidate ${n}`, resume_text: 'private' });
    tables.interview_round_consents.push({
      id: `consent-${n}`,
      round_id: roundId(n),
      template_id: TEMPLATE,
      consents: [...REQUIRED],
      proof: { decision: 'granted' },
      granted_at: new Date(NOW - 60_000).toISOString(),
      withdrawn_at: null,
    });
  }
  tables.r1_settings = [{
    singleton: true, enabled: true, paused: false,
    livekit_target: target,
    max_concurrent_sessions: opts.maxConcurrent ?? 15,
  }];

  // ── The lease table: the browser pool admission counts. ──
  let seq = 0;
  const leases: Row[] = Array.from({ length: machines }, (_, i) => ({
    id: `lease-${i + 1}`,
    app: APP,
    pipeline: 'browser',
    machine_id: machineId(i + 1),
    state: 'stopped',
    claimed_session_id: null,
    epoch: 0,
    registered_agent_name: null,
    livekit_host: null,
    updated_at: ++seq,
  }));
  tables.voice_worker_leases = leases;
  const lease = (app: string, id: string) => leases.find((l) => l.app === app && l.machine_id === id);
  const leaseRpcCalls: Array<{ name: string; args: Record<string, any> }> = [];

  const leaseRpcImpl = (name: string, a: Record<string, any>): Record<string, unknown> | unknown[] => {
    switch (name) {
      case 'claim_voice_worker': {
        const held = leases.find((l) => l.app === a.p_app && l.claimed_session_id === a.p_session_id
          && ['starting', 'ready', 'busy', 'draining'].includes(l.state));
        if (held) return { status: 'claimed', machine_id: held.machine_id, epoch: held.epoch };
        const free = leases
          .filter((l) => l.app === a.p_app && l.pipeline === a.p_pipeline && l.state === 'stopped')
          .sort((x, y) => x.updated_at - y.updated_at || String(x.machine_id).localeCompare(y.machine_id))[0];
        if (!free) return { status: 'no_capacity' };
        Object.assign(free, {
          state: 'starting', claimed_session_id: a.p_session_id, epoch: free.epoch + 1,
          registered_agent_name: null, livekit_host: null, updated_at: ++seq,
        });
        return { status: 'claimed', machine_id: free.machine_id, epoch: free.epoch };
      }
      case 'set_voice_worker_livekit_host': {
        const row = lease(a.p_app, a.p_machine_id);
        if (!row || row.pipeline !== 'browser' || !['starting', 'ready'].includes(row.state)) return { status: 'stale' };
        row.livekit_host = a.p_livekit_host;
        return { status: 'ok', updated: 1 };
      }
      case 'set_voice_worker_agent_name': {
        // 0112: the name must be of the stored-name class AND end in -<this machine id>.
        if (!/^[A-Za-z0-9_-]{1,64}-[0-9a-z]{8,32}$/.test(a.p_agent_name)
            || !String(a.p_agent_name).endsWith(`-${a.p_machine_id}`)) {
          return { status: 'invalid_request' };
        }
        const row = lease(a.p_app, a.p_machine_id);
        if (!row || !['starting', 'ready'].includes(row.state)) return { status: 'stale' };
        row.registered_agent_name = a.p_agent_name;
        return { status: 'ok', updated: 1 };
      }
      case 'mark_voice_worker_ready_machine': {
        const row = lease(a.p_app, a.p_machine_id);
        if (!row || !['starting', 'ready'].includes(row.state)) return { status: 'stale' };
        row.state = 'ready';
        return { status: 'ready', machine_id: row.machine_id, epoch: row.epoch };
      }
      case 'mark_voice_worker_busy': {
        const row = lease(a.p_app, a.p_machine_id);
        if (row && row.claimed_session_id === a.p_session_id && row.epoch === a.p_epoch && row.state === 'ready') {
          row.state = 'busy';
          return { status: 'busy' };
        }
        return { status: 'stale' };
      }
      case 'release_voice_worker': {
        const row = lease(a.p_app, a.p_machine_id);
        if (!row || row.claimed_session_id !== a.p_session_id
            || !['starting', 'ready', 'busy', 'draining'].includes(row.state)) {
          return { status: 'already_released' };
        }
        row.state = 'draining';
        row.updated_at = ++seq;
        return { status: 'draining', machine_id: row.machine_id };
      }
      case 'release_voice_worker_by_session': {
        const row = leases.find((l) => l.app === a.p_app && l.claimed_session_id === a.p_session_id
          && ['starting', 'ready', 'busy', 'draining'].includes(l.state));
        if (!row) return { status: 'already_released' };
        row.state = 'draining';
        row.updated_at = ++seq;
        return { status: 'draining', machine_id: row.machine_id, epoch: row.epoch };
      }
      case 'reset_voice_worker': {
        const row = lease(a.p_app, a.p_machine_id);
        if (!row) return { status: 'unknown_machine' };
        Object.assign(row, {
          state: 'stopped', claimed_session_id: null, registered_agent_name: null,
          livekit_host: null, updated_at: ++seq,
        });
        return { status: 'stopped', machine_id: row.machine_id };
      }
      case 'retire_voice_worker': {
        const at = leases.findIndex((l) => l.app === a.p_app && l.machine_id === a.p_machine_id);
        if (at < 0) return { status: 'unknown_machine' };
        if (leases[at]!.state !== 'stopped') return { status: 'not_stopped', state: leases[at]!.state };
        leases.splice(at, 1);
        return { status: 'retired', machine_id: a.p_machine_id };
      }
      case 'list_terminal_session_leases':
        return leases
          .filter((l) => l.app === a.p_app && ['starting', 'ready', 'busy', 'draining'].includes(l.state))
          .filter((l) => tables.call_sessions!.some((s) => s.id === l.claimed_session_id && TERMINAL.includes(s.status)))
          .slice(0, a.p_limit)
          .map((l) => ({ machine_id: l.machine_id, claimed_session_id: l.claimed_session_id }));
      case 'list_reapable_voice_workers':
        // Every non-stopped machine is past its grace in this simulation: the reaper must decide
        // on room liveness alone.
        return leases
          .filter((l) => l.app === a.p_app && l.state !== 'stopped')
          .map((l) => ({ machine_id: l.machine_id, claimed_session_id: l.claimed_session_id, state: l.state }));
      default:
        throw new Error(`unmodelled lease rpc ${name}`);
    }
  };
  const leaseRpc: RpcCaller = async (name, args) => {
    leaseRpcCalls.push({ name, args: args as Record<string, any> });
    return { data: leaseRpcImpl(name, args as Record<string, any>), error: null };
  };

  // ── LiveKit: registered workers and the dispatch store. ──
  const workers = new Map<string, SimWorker>();
  const dispatches: SimDispatch[] = [];
  /** Which machine accepted which room's job, in order. */
  const jobLog: Array<{ room: string; machineId: string; agentName: string }> = [];
  let dispatchSeq = 0;
  const endedAt = BigInt(NOW) * 1_000_000n;
  const asListed = (d: SimDispatch): DispatchLike => ({
    id: d.id,
    agentName: d.agentName,
    state: { jobs: d.state.jobs.map((j) => ({ ...j, state: { ...j.state } })), createdAt: d.state.createdAt },
  });
  const createDispatch = vi.fn(async (room: string, agentName: string, _options?: { metadata?: string }) => {
    dispatchSeq += 1;
    const d: SimDispatch = {
      id: `AD_sim_${dispatchSeq}`,
      room,
      agentName,
      state: { jobs: [], createdAt: BigInt(NOW) * 1_000_000n },
    };
    dispatches.push(d);
    // LiveKit hands the job to an idle worker registered under EXACTLY this name (one job each).
    const taker = [...workers.values()].filter((w) => w.name === agentName && w.job === null).at(-1);
    if (taker) {
      taker.job = { room, dispatchId: d.id };
      d.state.jobs.push({ id: `AJ_${d.id}`, state: { status: 1 } });
      jobLog.push({ room, machineId: taker.machineId, agentName });
    }
    return { id: d.id };
  });
  const listDispatch = async (room: string): Promise<DispatchLike[]> =>
    dispatches.filter((d) => d.room === room).map(asListed);
  const deleteDispatch = async (id: string): Promise<void> => {
    const at = dispatches.findIndex((d) => d.id === id);
    if (at >= 0) dispatches.splice(at, 1);
  };
  /** The browser gate's own client (createDispatch + the R1 safeguard's list/delete). */
  const gateClient = {
    createDispatch,
    listDispatch: vi.fn(listDispatch),
    deleteDispatch: vi.fn(deleteDispatch),
  };
  /** What the exchange route and the orphan lapse read: the SAME store, their own spies. */
  const routeLister = {
    listDispatch: vi.fn(listDispatch),
    deleteDispatch: vi.fn(deleteDispatch),
  };
  const roomHasAgent = async (room: string): Promise<boolean> =>
    [...workers.values()].some((w) => w.job?.room === room);

  // ── The worker's readiness ping, through the real route. ──
  const workerApp = express();
  workerApp.use(express.json());
  workerApp.use('/api/internal/voice-worker', createVoiceWorkerRouter({
    enabled: true,
    rpc: leaseRpc,
    now: () => new Date(NOW),
  }));
  const readyPosts: Array<{ machineId: string; status: number; body: any }> = [];

  async function bootWorker(id: string): Promise<void> {
    const bad = opts.misboot?.(id);
    const registers = bad ? bad.registers : workerPerMachine ? `${BASE}-${id}` : BASE;
    // agent.py reports a name only when it differs from the base.
    const reports = bad ? bad.reports : registers !== BASE ? registers : undefined;
    workers.set(id, { machineId: id, name: registers, job: null });
    const body = {
      app: APP,
      machine_id: id,
      ...(target === 'r1' ? { livekit_host: R1_HOST } : {}),
      ...(reports !== undefined ? { agent_name: reports } : {}),
    };
    const res = await request(workerApp)
      .post('/api/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${WORKER_SECRET}`)
      .send(body);
    readyPosts.push({ machineId: id, status: res.status, body: res.body });
    const corrupt = opts.corruptStoredName?.(id);
    if (corrupt !== undefined) lease(APP, id)!.registered_agent_name = corrupt;
  }

  function shutdownWorker(id: string): void {
    const w = workers.get(id);
    if (w?.job) {
      const d = dispatches.find((x) => x.id === w.job!.dispatchId);
      if (d) d.state.jobs = d.state.jobs.map((j) => ({ ...j, state: { status: 3, endedAt } }));
    }
    workers.delete(id);
  }

  // ── Fly. ──
  const machineState = new Map<string, string>(leases.map((l) => [l.machine_id, 'stopped']));
  const flyCalls: string[] = [];
  const fly = {
    async startMachine(_app: string, id: string) {
      flyCalls.push(`start:${id}`);
      // Starting a machine that is already started does not restart its worker process.
      if (machineState.get(id) === 'started') return {};
      machineState.set(id, 'started');
      await bootWorker(id);
      return {};
    },
    async stopMachine(_app: string, id: string) {
      flyCalls.push(`stop:${id}`);
      machineState.set(id, 'stopped');
      shutdownWorker(id);
      return {};
    },
    async waitForState() {
      return {};
    },
    async listMachines() {
      return [...machineState].map(([id, state]) => ({ id, state }));
    },
    async getMachine(_app: string, id: string) {
      return { id, state: machineState.get(id) ?? 'destroyed', raw: {} };
    },
  };

  // A virtual clock: only the failure paths (a readiness budget, a dispatch window) ever sleep.
  let clockMs = NOW;
  const now = () => clockMs;
  const sleep = async (ms: number) => {
    clockMs += ms;
    await Promise.resolve();
  };

  const readLeaseState = async ({ app, machineId: id }: { app: string; machineId: string }): Promise<LeaseStateSnapshot> => {
    const row = lease(app, id);
    if (!row) return { state: null, claimedSessionId: null, epoch: null };
    return {
      state: row.state,
      claimedSessionId: row.claimed_session_id,
      epoch: row.epoch,
      registeredAgentName: row.registered_agent_name,
      // The browser service selects livekit_host only on the R1 target (0118).
      ...(target === 'r1' ? { livekitHost: row.livekit_host } : {}),
    };
  };

  const events: string[] = [];
  const service: WorkerOrchestrationService = createWorkerOrchestrationService({
    enabled: true,
    rpc: leaseRpc,
    fly: fly as never,
    readLeaseState,
    roomIsLive: roomHasAgent,
    roomNameForSession,
    now,
    sleep,
    onEvent: (kind) => events.push(kind),
  });
  const realGate = browserOrchestrationGate({
    enabled: true,
    agentName: BASE,
    service,
    dispatchClient: gateClient as unknown as BrowserAgentDispatchClientLike,
    roomHasAgent,
    now,
    sleep,
  });
  if (realGate === null) throw new Error('gate not built');
  // The real gate, with its `dispatch` observed (its methods do not use `this`).
  const gate: BrowserWorkerGate & { dispatch: ReturnType<typeof vi.fn> } = {
    ...realGate,
    dispatch: vi.fn(realGate.dispatch),
  };

  const h: Harness = buildHarness(tables, {
    resolveGate: () => gate,
    dispatches: () => routeLister,
  });
  mocks.db.current = h.db;

  const adminApp = express();
  adminApp.use(express.json());
  adminApp.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).authUser = { id: OWNER, appRole: 'admin' };
    next();
  });
  adminApp.use('/api', r1Router);

  return {
    target, tables, leases, leaseRpcCalls, workers, dispatches, jobLog, createDispatch, gateClient,
    routeLister, readyPosts, flyCalls, events, service, gate, h, adminApp,
    clock: () => clockMs,
  };
}

// ── Candidate actions ───────────────────────────────────────────────────────

interface Secrets { attempt_token: string; nonce: string; attempt_id: string }

const startAttempt = (sim: Sim, n: number, extra: object = {}) =>
  request(sim.h.app).post('/api/r1/attempts').send({ token: linkOf(n), ...extra });
const exchange = (sim: Sim, s: Secrets) =>
  request(sim.h.app).post('/api/r1/exchange').send({ attempt_token: s.attempt_token, nonce: s.nonce });

interface Joined { n: number; attempt: request.Response; join?: request.Response }

/** One candidate: start an attempt and, if admitted, join the room. */
async function startAndJoin(sim: Sim, n: number): Promise<Joined> {
  const attempt = await startAttempt(sim, n);
  if (attempt.status !== 201) return { n, attempt };
  return { n, attempt, join: await exchange(sim, attempt.body as Secrets) };
}

/** Many candidates at the same instant. */
const everyone = (sim: Sim, ns: number[]) => Promise.all(ns.map((n) => startAndJoin(sim, n)));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const jwtRoom = (jwt: string): string =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')).video.room;

const leaseOf = (sim: Sim, sessionId: string) =>
  sim.leases.filter((l) => l.claimed_session_id === sessionId);
const liveSessions = (sim: Sim) =>
  sim.tables.call_sessions!.filter((s) => s.interview_round_id && LIVE.includes(s.status));

/**
 * THE invariant per-machine names exist for: every running job is on the machine whose lease is
 * claimed by THAT room's session, and no session holds two machines.
 */
function expectEveryJobOnItsOwnLease(sim: Sim): void {
  for (const w of sim.workers.values()) {
    if (!w.job) continue;
    const row = sim.leases.find((l) => l.machine_id === w.machineId);
    expect(row?.claimed_session_id, `machine ${w.machineId}`).toBeTruthy();
    expect(roomNameForSession(row!.claimed_session_id)).toBe(w.job.room);
  }
  const claimed = sim.leases.map((l) => l.claimed_session_id).filter(Boolean);
  expect(new Set(claimed).size).toBe(claimed.length);
}

/** Admit and join 15 candidates at once on a 15-machine pool; returns the admitted joins. */
async function fifteenLive(sim: Sim): Promise<Joined[]> {
  const results = await everyone(sim, range(1, 15));
  const joined = results.filter((r) => r.join?.status === 200);
  expect(joined).toHaveLength(15);
  return joined;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('15 at once on the self-hosted SFU (limit 15, pool 15, per-machine names required)', () => {
  it('16 simultaneous candidates: exactly 15 admitted, the 16th gets r1_busy slots_full with Retry-After 300', async () => {
    const sim = buildSim();
    const results = await everyone(sim, range(1, 16));

    const admitted = results.filter((r) => r.attempt.status === 201);
    const refused = results.filter((r) => r.attempt.status !== 201);
    expect(admitted).toHaveLength(15);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.attempt.status).toBe(409);
    expect(refused[0]!.attempt.body).toEqual({ error: 'r1_busy', retry_after_sec: 300, busy_reason: 'slots_full' });
    expect(refused[0]!.attempt.headers['retry-after']).toBe('300');
    // Admission ran 16 times and created exactly 15 live sessions.
    expect(sim.h.db.rpcCalls.filter((c) => c.fn === 'r1_admit_attempt')).toHaveLength(16);
    expect(liveSessions(sim)).toHaveLength(15);

    // Every admitted candidate joined (200, a token for THEIR room) on the first exchange.
    for (const r of admitted) {
      expect(r.join!.status).toBe(200);
      const sessionId = (r.attempt.body as Secrets).attempt_id;
      expect(r.join!.body.url).toBe(R1_URL);
      expect(jwtRoom(r.join!.body.livekit_token)).toBe(roomNameForSession(sessionId));
    }
    expect(mocks.startRecording).not.toHaveBeenCalled();
  });

  it('every admitted interview runs on a DISTINCT machine, dispatched to exactly <base>-<thatMachineId>', async () => {
    const sim = buildSim();
    const results = await everyone(sim, range(1, 16));
    const sessions = results.filter((r) => r.join?.status === 200).map((r) => (r.attempt.body as Secrets).attempt_id);
    expect(sessions).toHaveLength(15);

    const machinesUsed = new Set<string>();
    const namesUsed = new Set<string>();
    for (const sessionId of sessions) {
      const room = roomNameForSession(sessionId);
      const held = leaseOf(sim, sessionId);
      expect(held).toHaveLength(1);
      expect(held[0]!.state).toBe('ready');
      const machine = held[0]!.machine_id as string;
      const expected = `${BASE}-${machine}`;
      expect(held[0]!.registered_agent_name).toBe(expected);
      // One dispatch for the room, to that machine's own name, and the gate was told so.
      const calls = sim.createDispatch.mock.calls.filter((c) => c[0] === room);
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toBe(expected);
      expect(sim.gate.dispatch).toHaveBeenCalledWith({ sessionId, roomName: room, agentName: expected });
      // And the job really landed on that machine.
      expect(sim.jobLog.filter((j) => j.room === room)).toEqual([{ room, machineId: machine, agentName: expected }]);
      machinesUsed.add(machine);
      namesUsed.add(expected);
    }
    expect(machinesUsed.size).toBe(15);
    expect(namesUsed.size).toBe(15);
    // The shared name was never dispatched; each machine booted once; every ping was accepted.
    expect(sim.createDispatch.mock.calls.some((c) => c[1] === BASE)).toBe(false);
    expect(sim.flyCalls.filter((c) => c.startsWith('start:'))).toHaveLength(15);
    expect(new Set(sim.flyCalls).size).toBe(15);
    expect(sim.readyPosts).toHaveLength(15);
    expect(sim.readyPosts.every((p) => p.status === 200 && p.body.status === 'ready')).toBe(true);
    // Nothing was stopped or released during the rush.
    expect(sim.flyCalls.some((c) => c.startsWith('stop:'))).toBe(false);
    expectEveryJobOnItsOwnLease(sim);
  });

  it("ending interview A stops A's machine only; the reaper spares the 14 live rooms", async () => {
    const sim = buildSim();
    const joined = await fifteenLive(sim);
    const [a, ...others] = joined.map((r) => (r.attempt.body as Secrets).attempt_id);
    const machineA = leaseOf(sim, a!)[0]!.machine_id;
    const before = new Map(others.map((s) => [s, { ...leaseOf(sim, s!)[0]! }]));

    // A's interview ends: the worker's terminal write, then the prompt-release pass.
    sim.tables.call_sessions!.find((s) => s.id === a)!.status = 'completed';
    expect(await sim.service.releaseTerminalSessions({ app: APP })).toEqual({ released: 1 });
    expect(sim.flyCalls.filter((c) => c.startsWith('stop:'))).toEqual([`stop:${machineA}`]);
    expect(sim.leases.find((l) => l.machine_id === machineA)).toMatchObject({
      state: 'stopped', claimed_session_id: null, registered_agent_name: null,
    });
    for (const s of others) {
      expect(leaseOf(sim, s!)[0]).toEqual(before.get(s!));
      const w = sim.workers.get(before.get(s!)!.machine_id);
      expect(w?.job?.room).toBe(roomNameForSession(s!));
    }

    // A repeated terminal release for A (any terminal path firing twice) touches nothing.
    await sim.service.releaseWorkerBySession({ app: APP, sessionId: a! });
    expect(sim.flyCalls.filter((c) => c.startsWith('stop:'))).toEqual([`stop:${machineA}`]);

    // The reaper, with all 14 still running, stops nothing: every room has its interviewer.
    expect(await sim.service.reapWorkers({ app: APP })).toMatchObject({ stopped: 0 });
    expect(sim.flyCalls.filter((c) => c.startsWith('stop:'))).toHaveLength(1);
    expectEveryJobOnItsOwnLease(sim);
  });

  it('a gate refusal for one session (release of a claim) never stops a machine leased to another', async () => {
    const sim = buildSim();
    const joined = await fifteenLive(sim);
    const [a, b] = joined.map((r) => (r.attempt.body as Secrets).attempt_id);
    const machineB = leaseOf(sim, b!)[0]!.machine_id;
    // A stale caller releasing B's machine under A's session id: the release CAS proves it is not
    // A's, so nothing is stopped or reset.
    await sim.gate.releaseWorker({ machineId: machineB, sessionId: a! });
    expect(sim.flyCalls.some((c) => c.startsWith('stop:'))).toBe(false);
    expect(leaseOf(sim, b!)[0]).toMatchObject({ machine_id: machineB, state: 'ready' });
    expect(sim.events).toContain('cleanup_not_held');
  });
});

describe('a freed slot is reused', () => {
  it('one interview ends and releases: the waiting 16th candidate is admitted and gets the freed machine', async () => {
    const sim = buildSim();
    const first = await everyone(sim, range(1, 16));
    const refused = first.find((r) => r.attempt.status === 409)!;
    const live = first.filter((r) => r.join?.status === 200).map((r) => (r.attempt.body as Secrets).attempt_id);
    const ended = live[3]!;
    const freed = leaseOf(sim, ended)[0]!.machine_id as string;

    // Still full: a retry before anything ends is refused the same way.
    const early = await startAttempt(sim, refused.n);
    expect(early.status).toBe(409);
    expect(early.body).toEqual({ error: 'r1_busy', retry_after_sec: 300, busy_reason: 'slots_full' });

    sim.tables.call_sessions!.find((s) => s.id === ended)!.status = 'completed';
    expect(await sim.service.releaseTerminalSessions({ app: APP })).toEqual({ released: 1 });

    const retry = await startAndJoin(sim, refused.n);
    expect(retry.attempt.status).toBe(201);
    expect(retry.join!.status).toBe(200);
    const sessionId = (retry.attempt.body as Secrets).attempt_id;
    expect(leaseOf(sim, sessionId)).toEqual([expect.objectContaining({ machine_id: freed, state: 'ready' })]);
    const room = roomNameForSession(sessionId);
    expect(sim.createDispatch.mock.calls.filter((c) => c[0] === room).map((c) => c[1])).toEqual([`${BASE}-${freed}`]);
    expect(sim.jobLog.at(-1)).toEqual({ room, machineId: freed, agentName: `${BASE}-${freed}` });
    // The freed machine booted twice (two interviews), every other machine once.
    expect(sim.flyCalls.filter((c) => c === `start:${freed}`)).toHaveLength(2);
    expect(liveSessions(sim)).toHaveLength(15);
    expectEveryJobOnItsOwnLease(sim);
  });

  it('three waves of 15 (45 interviews) churn through the pool with one interview per machine throughout', async () => {
    const sim = buildSim({ candidates: 45 });
    for (const wave of [range(1, 15), range(16, 30), range(31, 45)]) {
      const joined = (await everyone(sim, wave)).filter((r) => r.join?.status === 200);
      expect(joined).toHaveLength(15);
      expectEveryJobOnItsOwnLease(sim);
      // Everyone in the wave finishes; the prompt-release pass frees all 15 machines at once.
      for (const r of joined) {
        sim.tables.call_sessions!.find((s) => s.id === (r.attempt.body as Secrets).attempt_id)!.status = 'completed';
      }
      expect(await sim.service.releaseTerminalSessions({ app: APP })).toEqual({ released: 15 });
      expect(sim.leases.every((l) => l.state === 'stopped' && l.claimed_session_id === null)).toBe(true);
      expect(sim.workers.size).toBe(0);
    }
    expect(sim.jobLog).toHaveLength(45);
    expect(sim.jobLog.every((j) => j.agentName === `${BASE}-${j.machineId}`)).toBe(true);
    expect(new Set(sim.jobLog.map((j) => j.room)).size).toBe(45);
    expect(sim.flyCalls.filter((c) => c.startsWith('start:'))).toHaveLength(45);
    expect(sim.flyCalls.filter((c) => c.startsWith('stop:'))).toHaveLength(45);
  });
});

describe("a candidate's second tab", () => {
  it('a second tab without the nonce is r1_busy own_session_live (300), and the nonce rejoin re-uses the running interviewer', async () => {
    const sim = buildSim();
    const joined = await fifteenLive(sim);
    const mine = joined[0]!;
    const secrets = mine.attempt.body as Secrets;
    const room = roomNameForSession(secrets.attempt_id);

    // Both a slot-full pool and the candidate's own live round: own_session_live wins (0131 order).
    const tab2 = await startAttempt(sim, mine.n);
    expect(tab2.status).toBe(409);
    expect(tab2.body).toEqual({ error: 'r1_busy', retry_after_sec: 300, busy_reason: 'own_session_live' });
    expect(tab2.headers['retry-after']).toBe('300');

    // With a free slot it is still own_session_live (never a second session for the round).
    const other = joined[1]!;
    sim.tables.call_sessions!.find((s) => s.id === (other.attempt.body as Secrets).attempt_id)!.status = 'completed';
    await sim.service.releaseTerminalSessions({ app: APP });
    const tab3 = await startAttempt(sim, mine.n);
    expect(tab3.body).toEqual({ error: 'r1_busy', retry_after_sec: 300, busy_reason: 'own_session_live' });
    expect(sim.tables.call_sessions!.filter((s) => s.interview_round_id === roundId(mine.n))).toHaveLength(1);

    // The page's rejoin (link + nonce) re-mints for the same attempt and joins the SAME room: the
    // per-machine dispatch is recognised as ours, so no second machine and no second interviewer.
    const claimsBefore = sim.leaseRpcCalls.filter((c) => c.name === 'claim_voice_worker').length;
    const myMachine = leaseOf(sim, secrets.attempt_id)[0]!.machine_id as string;
    const rejoin = await startAttempt(sim, mine.n, { nonce: secrets.nonce });
    expect(rejoin.status).toBe(200);
    expect(rejoin.body.rejoin).toBe(true);
    const again = await exchange(sim, { ...secrets, attempt_token: rejoin.body.attempt_token });
    expect(again.status).toBe(200);
    expect(jwtRoom(again.body.livekit_token)).toBe(room);
    expect(sim.createDispatch.mock.calls.filter((c) => c[0] === room)).toHaveLength(1);
    expect(sim.leaseRpcCalls.filter((c) => c.name === 'claim_voice_worker')).toHaveLength(claimsBefore);
    expect(sim.jobLog.filter((j) => j.room === room)).toHaveLength(1);
    // The running interview was never disturbed: its machine is not stopped and still has the job.
    expect(sim.flyCalls).not.toContain(`stop:${myMachine}`);
    expect(sim.workers.get(myMachine)?.job?.room).toBe(room);
    expect(leaseOf(sim, secrets.attempt_id)).toEqual([expect.objectContaining({ machine_id: myMachine, state: 'ready' })]);
  });
});

describe('a worker that registers under the wrong name is refused, deferred and its machine released', () => {
  it("reporting ANOTHER machine's name: the ready ping is refused (0112), the claim times out and is stopped; the retry lands on a good machine", async () => {
    const bad = machineId(1);
    const sim = buildSim({
      misboot: (id) => (id === bad ? { registers: `${BASE}-${machineId(2)}`, reports: `${BASE}-${machineId(2)}` } : undefined),
    });
    // Four candidates at once; whichever session claims the bad machine is deferred.
    const results = await everyone(sim, range(1, 4));
    expect(results.every((r) => r.attempt.status === 201)).toBe(true);
    const deferred = results.filter((r) => r.join!.status === 202);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.join!.body).toEqual({ status: 'preparing', retry_after_sec: 3 });
    expect(deferred[0]!.join!.body.livekit_token).toBeUndefined();
    expect(results.filter((r) => r.join!.status === 200)).toHaveLength(3);

    expect(sim.readyPosts.find((p) => p.machineId === bad)).toMatchObject({ status: 500 });
    // Nothing was ever dispatched for the deferred room, and no other worker got its job.
    const deferredSession = (deferred[0]!.attempt.body as Secrets).attempt_id;
    const deferredRoom = roomNameForSession(deferredSession);
    expect(sim.createDispatch.mock.calls.some((c) => c[0] === deferredRoom)).toBe(false);
    // The bad machine was released (release -> stop -> reset), and only it.
    expect(sim.flyCalls.filter((c) => c.startsWith('stop:'))).toEqual([`stop:${bad}`]);
    expect(sim.leases.find((l) => l.machine_id === bad)).toMatchObject({ state: 'stopped', claimed_session_id: null });
    expect(sim.events).toContain('ready_timeout');
    expectEveryJobOnItsOwnLease(sim);

    // The candidate's page retries: least-recently-stopped puts the bad machine LAST, so the retry
    // claims a fresh machine and joins.
    const retry = await exchange(sim, deferred[0]!.attempt.body as Secrets);
    expect(retry.status).toBe(200);
    const used = leaseOf(sim, deferredSession)[0]!.machine_id;
    expect(used).not.toBe(bad);
    expect(sim.createDispatch.mock.calls.filter((c) => c[0] === deferredRoom).map((c) => c[1])).toEqual([`${BASE}-${used}`]);
    expectEveryJobOnItsOwnLease(sim);
  });

  it('reporting a name under another base: the gate refuses the lease before any dispatch and releases it', async () => {
    const bad = machineId(1);
    const sim = buildSim({
      misboot: (id) => (id === bad ? { registers: `other-screener-${id}`, reports: `other-screener-${id}` } : undefined),
    });
    const only = await startAndJoin(sim, 1);
    expect(only.join!.status).toBe(202);
    // The name passes 0112 (it ends in -<id>), so the lease read ready with it; the gate refused it.
    expect(sim.readyPosts).toEqual([expect.objectContaining({ machineId: bad, status: 200 })]);
    expect(sim.createDispatch).not.toHaveBeenCalled();
    expect(sim.gate.dispatch).not.toHaveBeenCalled();
    expect(sim.flyCalls).toEqual([`start:${bad}`, `stop:${bad}`]);
    expect(sim.leases.find((l) => l.machine_id === bad)).toMatchObject({ state: 'stopped', claimed_session_id: null });
  });

  it("a lease row that carries ANOTHER machine's name (unreachable via 0112; a drifted row) is never dispatched to", async () => {
    const bad = machineId(1);
    const sim = buildSim({ corruptStoredName: (id) => (id === bad ? `${BASE}-${machineId(2)}` : undefined) });
    const only = await startAndJoin(sim, 1);
    expect(only.join!.status).toBe(202);
    expect(only.join!.body.livekit_token).toBeUndefined();
    // Neither the other machine's name nor the shared one: nothing was dispatched at all.
    expect(sim.createDispatch).not.toHaveBeenCalled();
    expect(sim.gate.dispatch).not.toHaveBeenCalled();
    expect(sim.flyCalls).toEqual([`start:${bad}`, `stop:${bad}`]);
    expect(sim.leases.find((l) => l.machine_id === bad)).toMatchObject({ state: 'stopped', claimed_session_id: null });
    // The retry claims the next machine and joins on its own name.
    const retry = await exchange(sim, only.attempt.body as Secrets);
    expect(retry.status).toBe(200);
    expect(sim.createDispatch.mock.calls.map((c) => c[1])).toEqual([`${BASE}-${machineId(2)}`]);
    expect(sim.jobLog).toEqual([{
      room: roomNameForSession((only.attempt.body as Secrets).attempt_id),
      machineId: machineId(2),
      agentName: `${BASE}-${machineId(2)}`,
    }]);
  });

  it('a worker with no per-machine name while names are required: refused and released, the shared name never dispatched', async () => {
    const sim = buildSim({ perMachineNames: false, requireNames: true });
    const results = await everyone(sim, range(1, 3));
    expect(results.map((r) => r.join!.status)).toEqual([202, 202, 202]);
    expect(sim.createDispatch).not.toHaveBeenCalled();
    expect(sim.flyCalls.filter((c) => c.startsWith('stop:'))).toHaveLength(3);
    expect(sim.leases.every((l) => l.state === 'stopped')).toBe(true);
  });
});

describe('the defaults (limit 1, flags off) are exactly the single-slot behaviour of main', () => {
  it('Cloud: two simultaneous candidates, one admitted, the other gets {r1_busy, 1800}; one createDispatch to the shared name', async () => {
    const sim = buildSim({ target: 'cloud', maxConcurrent: 1, perMachineNames: false, requireNames: false, candidates: 2 });
    const results = await everyone(sim, [1, 2]);
    const admitted = results.filter((r) => r.attempt.status === 201);
    const refused = results.filter((r) => r.attempt.status !== 201);
    expect(admitted).toHaveLength(1);
    expect(refused[0]!.attempt.status).toBe(409);
    expect(refused[0]!.attempt.body).toEqual({ error: 'r1_busy', retry_after_sec: 1800 });
    expect(refused[0]!.attempt.headers['retry-after']).toBe('1800');

    expect(admitted[0]!.join!.status).toBe(200);
    const sessionId = (admitted[0]!.attempt.body as Secrets).attempt_id;
    const room = roomNameForSession(sessionId);
    expect(sim.gate.dispatch.mock.calls).toEqual([[{ sessionId, roomName: room }]]);
    expect(sim.createDispatch.mock.calls).toEqual([[
      room, BASE, { metadata: JSON.stringify({ session_id: sessionId, channel: 'browser' }) },
    ]]);
    // Cloud is byte-identical: the gate never lists or deletes a dispatch, and the worker's ready
    // body is the pre-M019 {app, machine_id}.
    expect(sim.gateClient.listDispatch).not.toHaveBeenCalled();
    expect(sim.gateClient.deleteDispatch).not.toHaveBeenCalled();
    expect(sim.leaseRpcCalls.some((c) => c.name === 'set_voice_worker_agent_name' || c.name === 'set_voice_worker_livekit_host')).toBe(false);
  });

  it('R1 target at limit 1 with flags off: one admitted, {r1_busy, 1800}, and the R1 dispatch goes to the shared name', async () => {
    const sim = buildSim({ target: 'r1', maxConcurrent: 1, perMachineNames: false, requireNames: false, candidates: 2 });
    const results = await everyone(sim, [1, 2]);
    expect(results.filter((r) => r.attempt.status === 201)).toHaveLength(1);
    const refused = results.find((r) => r.attempt.status !== 201)!;
    expect(refused.attempt.body).toEqual({ error: 'r1_busy', retry_after_sec: 1800 });
    expect(refused.attempt.headers['retry-after']).toBe('1800');
    const admitted = results.find((r) => r.attempt.status === 201)!;
    expect(admitted.join!.status).toBe(200);
    const sessionId = (admitted.attempt.body as Secrets).attempt_id;
    const room = roomNameForSession(sessionId);
    expect(sim.gate.dispatch.mock.calls).toEqual([[{ sessionId, roomName: room }]]);
    expect(sim.createDispatch.mock.calls).toEqual([[
      room, BASE, { metadata: JSON.stringify({ session_id: sessionId, channel: 'browser' }) },
    ]]);
    expect(sim.leaseRpcCalls.some((c) => c.name === 'set_voice_worker_agent_name')).toBe(false);
  });

  it('an older database (no max_concurrent_sessions column) on R1 keeps one slot and the 1800 answer', async () => {
    const sim = buildSim({ target: 'r1', perMachineNames: false, requireNames: false, candidates: 3 });
    delete sim.tables.r1_settings![0]!.max_concurrent_sessions;
    const results = await everyone(sim, [1, 2, 3]);
    expect(results.filter((r) => r.attempt.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.attempt.status !== 201)) {
      expect(r.attempt.body).toEqual({ error: 'r1_busy', retry_after_sec: 1800 });
    }
  });
});

describe('Cloud target ignores the setting', () => {
  it('limit 15, pool 15, flags on, 16 simultaneous candidates on Cloud: exactly one admitted, the rest {r1_busy, 1800}', async () => {
    const sim = buildSim({ target: 'cloud', maxConcurrent: 15 });
    const results = await everyone(sim, range(1, 16));
    expect(results.filter((r) => r.attempt.status === 201)).toHaveLength(1);
    const refused = results.filter((r) => r.attempt.status !== 201);
    expect(refused).toHaveLength(15);
    for (const r of refused) {
      expect(r.attempt.status).toBe(409);
      expect(r.attempt.body).toEqual({ error: 'r1_busy', retry_after_sec: 1800 });
      expect(r.attempt.headers['retry-after']).toBe('1800');
    }
    expect(liveSessions(sim)).toHaveLength(1);
    // The one interview is dispatched to the shared name (Cloud ignores per-machine names).
    expect(sim.createDispatch.mock.calls.map((c) => c[1])).toEqual([BASE]);
  });
});

describe('the settings interlock (PUT /api/admin/r1/settings)', () => {
  it('raising to 15 while BROWSER_REQUIRE_MACHINE_AGENT_NAME is off is 409 r1_concurrency_needs_machine_names and admission stays single-slot', async () => {
    const sim = buildSim({ maxConcurrent: 1, requireNames: false });
    const put = await request(sim.adminApp).put('/api/admin/r1/settings').send({ max_concurrent_sessions: 15 });
    expect(put.status).toBe(409);
    expect(put.body).toEqual({ error: 'r1_concurrency_needs_machine_names' });
    expect(sim.tables.r1_settings![0]!.max_concurrent_sessions).toBe(1);
    expect(audits.filter((a) => a.metadata?.resource === 'r1_settings')).toHaveLength(0);
    const results = await Promise.all(range(1, 4).map((n) => startAttempt(sim, n)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.retry_after_sec === 1800)).toBe(true);
  });

  it('with the flag on and 15 machines, the PUT stores 15 and the next rush admits exactly 15', async () => {
    const sim = buildSim({ maxConcurrent: 1, requireNames: true });
    const tooMany = await request(sim.adminApp).put('/api/admin/r1/settings').send({ max_concurrent_sessions: 16 });
    expect(tooMany.status).toBe(400);
    const put = await request(sim.adminApp).put('/api/admin/r1/settings').send({ max_concurrent_sessions: 15 });
    expect(put.status).toBe(200);
    expect(sim.tables.r1_settings![0]!.max_concurrent_sessions).toBe(15);
    const results = await everyone(sim, range(1, 16));
    expect(results.filter((r) => r.join?.status === 200)).toHaveLength(15);
    expect(results.filter((r) => r.attempt.status === 409)).toHaveLength(1);
  });

  it('a pool that has shrunk below the setting caps admission at the pool (and the PUT refuses to go above it)', async () => {
    const sim = buildSim({ machines: 10, maxConcurrent: 15 });
    const put = await request(sim.adminApp).put('/api/admin/r1/settings').send({ max_concurrent_sessions: 15 });
    expect(put.status).toBe(409);
    expect(put.body).toEqual({ error: 'r1_concurrency_above_worker_pool', browser_worker_pool_size: 10 });
    const results = await everyone(sim, range(1, 16));
    expect(results.filter((r) => r.join?.status === 200)).toHaveLength(10);
    const refused = results.filter((r) => r.attempt.status === 409);
    expect(refused).toHaveLength(6);
    expect(refused.every((r) => r.attempt.body.busy_reason === 'slots_full')).toBe(true);
    expect(sim.leaseRpcCalls.filter((c) => c.name === 'claim_voice_worker')).toHaveLength(10);
  });

  it('a rollback that turns BROWSER_REQUIRE_MACHINE_AGENT_NAME off while the limit is still 15: every R1 join defers, nothing is claimed or dispatched to the shared name', async () => {
    // Workers already redeployed without per-machine names (all register the shared name).
    const sim = buildSim({ maxConcurrent: 15, perMachineNames: false, requireNames: false, candidates: 3 });
    const results = await everyone(sim, [1, 2, 3]);
    // Admission knows nothing of the flag: it still admits up to the limit ...
    expect(results.filter((r) => r.attempt.status === 201)).toHaveLength(3);
    // ... but the dispatch-time interlock defers every join before a machine is touched.
    for (const r of results) {
      expect(r.join!.status).toBe(202);
      expect(r.join!.body).toEqual({ status: 'preparing', retry_after_sec: 3 });
    }
    expect(sim.leaseRpcCalls.filter((c) => c.name === 'claim_voice_worker')).toHaveLength(0);
    expect(sim.gate.dispatch).not.toHaveBeenCalled();
    expect(sim.createDispatch).not.toHaveBeenCalled();

    // Setting the limit back to 1 does not release the three already admitted onto one shared
    // name: while another R1 session is live, each join still defers.
    sim.tables.r1_settings![0]!.max_concurrent_sessions = 1;
    for (const r of results) {
      expect((await exchange(sim, r.attempt.body as Secrets)).status).toBe(202);
    }
    expect(sim.createDispatch).not.toHaveBeenCalled();

    // Once the other two have ended, the last one proceeds on the shared name.
    const ids = results.map((r) => (r.attempt.body as Secrets).attempt_id);
    for (const s of sim.tables.call_sessions!) if (s.id !== ids[0] && ids.includes(s.id)) s.status = 'failed';
    const again = await exchange(sim, results[0]!.attempt.body as Secrets);
    expect(again.status).toBe(200);
    expect(sim.createDispatch.mock.calls.map((c) => c[1])).toEqual([BASE]);
  });

  it('flag off on R1 with an older database (no max_concurrent_sessions column) and one live interview: it proceeds on the shared name, as today', async () => {
    const sim = buildSim({ perMachineNames: false, requireNames: false, candidates: 1 });
    delete sim.tables.r1_settings![0]!.max_concurrent_sessions;
    const [only] = await everyone(sim, [1]);
    expect(only!.join!.status).toBe(200);
    expect(sim.createDispatch.mock.calls.map((c) => c[1])).toEqual([BASE]);
  });

});

describe('the orphan lapse with 15 live interviews', () => {
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

  it('15 live + 10 stale rows: only the 10 stale lapse, each exactly once, and the live ones keep their machines', async () => {
    const sim = buildSim({ candidates: 25 });
    const joined = await fifteenLive(sim);
    const live = joined.map((r) => (r.attempt.body as Secrets).attempt_id);
    // R1 sessions stay `waiting` for the whole interview, so 25 minutes in, the 15 live rows are
    // stale BY TIMESTAMP: only the live job in each room keeps them.
    for (const s of sim.tables.call_sessions!) {
      Object.assign(s, { started_at: minutesAgo(26), waiting_at: minutesAgo(25), updated_at: minutesAgo(25) });
    }
    // 10 orphans on rounds 16..25: 4 `created` (tab died), 4 `waiting` with no worker, 2 `waiting`
    // whose worker died (a dispatch whose job ENDED does not spare them).
    const orphans: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = `70000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      orphans.push(id);
      const status = i < 4 ? 'created' : 'waiting';
      sim.tables.call_sessions!.push({
        id, candidate_id: candidateId(16 + i), status, interview_round_id: roundId(16 + i), mode: 'browser',
        external_call_id: roomNameForSession(id), started_at: minutesAgo(40),
        waiting_at: status === 'waiting' ? minutesAgo(30) : null, updated_at: minutesAgo(30),
      });
      sim.tables.interview_round_attempts!.push({ session_id: id, round_id: roundId(16 + i), attempt_number: 1, outcome: null });
      if (i >= 8) {
        sim.dispatches.push({
          id: `AD_dead_${i}`, room: roomNameForSession(id), agentName: `${BASE}-${machineId(1)}`,
          state: { jobs: [{ id: `AJ_dead_${i}`, state: { status: 3, endedAt: 1n } }], createdAt: 1n },
        });
      }
    }
    expect(liveSessions(sim)).toHaveLength(25);

    const settled = new Map<string, number>();
    const settleRpc = (fn: string, args: Record<string, any>) => {
      if (fn !== 'r1_settle_attempt') return { data: { status: 'ok' } };
      settled.set(args.p_session_id, (settled.get(args.p_session_id) ?? 0) + 1);
      return { data: { status: settled.get(args.p_session_id)! > 1 ? 'duplicate' : 'ok', counted: false } };
    };
    const lapseDb = createR1FakeDb(sim.tables, settleRpc);
    const pass = () => lapseOrphanedR1Sessions(lapseDb.client as never, new Date(NOW), {
      dispatches: () => sim.routeLister,
    });

    expect(await pass()).toEqual({ scanned: 25, lapsed: 10, settled: 10, errors: 0 });
    for (const id of orphans) {
      const row = sim.tables.call_sessions!.find((s) => s.id === id)!;
      expect(TERMINAL).toContain(row.status);
    }
    for (const id of live) {
      expect(sim.tables.call_sessions!.find((s) => s.id === id)!.status).toBe('waiting');
      expect(leaseOf(sim, id)).toEqual([expect.objectContaining({ state: 'ready' })]);
    }
    expect([...settled.keys()].sort()).toEqual([...orphans].sort());
    expect([...settled.values()].every((count) => count === 1)).toBe(true);
    // A second pass a minute later lapses nothing more and settles nothing twice.
    expect(await pass()).toEqual({ scanned: 15, lapsed: 0, settled: 0, errors: 0 });
    expect([...settled.values()].every((count) => count === 1)).toBe(true);
    expect(liveSessions(sim)).toHaveLength(15);
    // The lapse never touches a machine: stopping is the release path's job.
    expect(sim.flyCalls.some((c) => c.startsWith('stop:'))).toBe(false);
    expectEveryJobOnItsOwnLease(sim);
  });
});

describe('scoring 15 interviews that end together (R1_ASSESSMENT_CONCURRENCY=4)', () => {
  const rows = interviewRows();
  const allScores = (score: number) => Object.fromEntries(R1_METRICS.map((m) => [m.key, score]));
  const sid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rid = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const cid = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  function fifteenCompleted(): Tables {
    const tables = scorerBaseTables();
    const template = tables.call_sessions![0]!;
    tables.call_sessions = [];
    tables.candidates = [];
    tables.interview_round_attempts = [];
    tables.transcript_turns = [];
    tables.r1_admin_log = [];
    for (let n = 1; n <= 15; n += 1) {
      tables.call_sessions.push({ ...template, id: sid(n), candidate_id: cid(n), interview_round_id: rid(n) });
      tables.candidates.push({ id: cid(n), name: `Candidate ${n}` });
      tables.interview_round_attempts.push({ session_id: sid(n), round_id: rid(n), attempt_number: 1, outcome: 'complete' });
      tables.transcript_turns.push(...rows.map((row) => ({ ...row, session_id: sid(n), is_gate: false })));
      tables.r1_admin_log.push(...cleanLogRows().map((row) => ({ ...row, session_id: sid(n), round_id: rid(n) })));
    }
    return tables;
  }

  it('15 assessments, each scored exactly once, four at a time, none dead-lettered', async () => {
    env.r1AssessmentConcurrency = r1AssessmentConcurrencyFrom('4');
    const tables = fifteenCompleted();
    const attached: string[] = [];
    const db = createR1FakeDb(tables, (fn, args) => {
      if (fn === 'r1_attach_assessment') {
        attached.push(String(args.p_session_id ?? ''));
        return { data: { status: 'ok', attached: true } };
      }
      if (fn === 'r1_apply_status_effect') return { data: { status: 'ok', status_write: 'flag_off' } };
      return { data: { status: 'ok' } };
    });
    const clock = (): string => '2026-10-06T10:00:00.000Z';
    const queue = new Queue(new MemoryAdapter({ clock }), { clock });
    // The 0116 trigger enqueues one job per session, keyed by the session.
    for (let n = 1; n <= 15; n += 1) {
      await queue.enqueue(R1_ASSESSMENT_QUEUE, { session_id: sid(n) }, {
        dedupKey: `${R1_ASSESSMENT_QUEUE}:${sid(n)}`, maxAttempts: 5,
      });
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const infer = vi.fn(async () => {
      await gate;
      return modelAnswer(rows, allScores(3));
    });
    // No seam: the runtime reads env.r1AssessmentConcurrency, as production does.
    const runtime = createR1Runtime({ config: { enabled: true, status: 'enabled' }, client: db.client as never, queue, infer })!;
    expect(runtime.assessmentConcurrency).toBe(4);

    await runtime.runner.tick();
    expect(runtime.runner.inFlight()).toBe(4);
    release();
    for (let i = 0; i < 60 && (tables.assessments?.length ?? 0) < 15; i += 1) {
      await runtime.runner.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await runtime.runner.stop();

    expect(runtime.runner.peakInFlight()).toBe(4);
    expect(tables.assessments).toHaveLength(15);
    expect(new Set(tables.assessments!.map((a) => a.session_id))).toEqual(new Set(range(1, 15).map(sid)));
    expect(tables.assessments!.every((a) => a.recommendation === 'advance')).toBe(true);
    // Three model runs per interview, never a second scoring of one.
    expect(infer).toHaveBeenCalledTimes(45);
    expect(runtime.snapshot().jobEvents.completed).toBe(15);
    expect(runtime.snapshot().jobEvents.failed ?? 0).toBe(0);
    expect(await queue.getDlqJobs()).toHaveLength(0);
    expect(attached).toHaveLength(15);
    expect(new Set(attached)).toEqual(new Set(range(1, 15).map(sid)));
  });
});
