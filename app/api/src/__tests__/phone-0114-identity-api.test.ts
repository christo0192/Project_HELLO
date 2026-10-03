/**
 * 0114 §6 (C8) — the API and TS side of the person-identity guards (P6).
 *
 *   A. rpc-contract registers `release_phone_identity_hold` and the full
 *      `schedule_candidate_phone_appointment` vocabulary (incl.
 *      `duplicate_application`) OUTSIDE the store bijection, pinned to 0114.
 *   B. The due pass offers ONE engagement per LINE per pass
 *      (`line_already_offered`), keyed on the number's digest, never emitting
 *      the number.
 *   C. Ashby import writes `external_candidate_id` on create and backfills it
 *      on reuse with a compare-and-set; the value is never logged.
 *   D. Routes: the manual request and the booking answer 409
 *      `duplicate_application`; POST /candidates/:id/phone/release-duplicate-hold
 *      resolves the held engagement server-side and maps every release answer.
 *
 * HTTP tests run against the real candidatesRouter with a mocked supabase
 * module (no network, no database).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { candidatesRouter } from '../routes/candidates.js';
import { finalErrorHandler } from '../lib/validation.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import {
  PHONE_DUPLICATE_APPLICATION_STATUS,
  PHONE_IDENTITY_RPC_PARAMETERS,
  PHONE_RPC_NAMES,
  RELEASE_PHONE_IDENTITY_HOLD_RESULT_KEYS,
  RELEASE_PHONE_IDENTITY_HOLD_STATUSES,
  SCHEDULE_CANDIDATE_PHONE_APPOINTMENT_OWN_STATUSES,
  SCHEDULE_CANDIDATE_PHONE_APPOINTMENT_STATUSES,
  SCHEDULE_PHONE_APPOINTMENT_STATUSES,
} from '../lib/phone-screening/rpc-contract.js';
import {
  PHONE_DUE_SKIPS,
  phoneDueDiagSummary,
  runPhoneDuePass,
  type PhoneDialPort,
  type PhoneDueDeps,
  type PhoneSessionPort,
} from '../lib/phone-runtime/due-loop.js';
import type { DuePhoneEngagement, PhoneRuntimeReader } from '../lib/phone-runtime/read.js';
import type { PhoneScreeningConfig, PhoneStores } from '../lib/phone-screening/index.js';
import type { DialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import {
  runImport,
  type ApplicationReader,
  type ExistingLinkRow,
  type OrchestrationGates,
  type ResolvedMapping,
  type WorkflowStores,
  type EnqueueResult,
} from '../integrations/ashby/orchestration.js';
import { createWorkflowStores } from '../integrations/ashby/workflow-stores.js';
import { createPhoneReadStore } from '../lib/phone-screening/read-stores.js';
import { functionBody, functionParameters, functionStatuses } from './support/phone-migration.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const ACTOR_ID = '66666666-6666-4666-8666-666666666666';
const CANDIDATE_ID = '0cd4b8e0-0000-4000-8000-000000000001';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
// 14:00 IST, inside every calling window.
const NOW = new Date('2026-10-03T08:30:00.000Z');

// ═══════════════════════════════════════════════════════════════════════
// A. rpc-contract registration
// ═══════════════════════════════════════════════════════════════════════

describe('A. rpc-contract registers the §6 RPCs against the 0114 bodies', () => {
  it('parameter names match the 0114 signatures, outside the store bijection', () => {
    for (const [name, params] of Object.entries(PHONE_IDENTITY_RPC_PARAMETERS)) {
      expect(functionParameters(name), name).toEqual([...params]);
      expect(PHONE_RPC_NAMES as readonly string[], name).not.toContain(name);
    }
  });

  it('release_phone_identity_hold: the status vocabulary is exactly the body\'s', () => {
    expect([...functionStatuses('release_phone_identity_hold')].sort()).toEqual(
      [...RELEASE_PHONE_IDENTITY_HOLD_STATUSES].sort(),
    );
  });

  it('release_phone_identity_hold: every result key the route reads is emitted', () => {
    const body = functionBody('release_phone_identity_hold');
    for (const key of RELEASE_PHONE_IDENTITY_HOLD_RESULT_KEYS) {
      expect(body, key).toContain(`'${key}'`);
    }
  });

  it('schedule_candidate_phone_appointment: own statuses are exactly the body\'s, incl. duplicate_application', () => {
    // `unknown_status` is extracted from `coalesce(v_result->>'status',
    // 'unknown_status')` — the INTERNAL default for an ensure answer with no
    // status. It is never returned: such an answer has no engagement id and
    // falls through to `prerequisites_unavailable`.
    const extracted = functionStatuses('schedule_candidate_phone_appointment');
    expect(functionBody('schedule_candidate_phone_appointment'))
      .toContain("coalesce(v_result->>'status', 'unknown_status')");
    extracted.delete('unknown_status');
    expect([...extracted].sort()).toEqual(
      [...SCHEDULE_CANDIDATE_PHONE_APPOINTMENT_OWN_STATUSES].sort(),
    );
    expect(SCHEDULE_CANDIDATE_PHONE_APPOINTMENT_OWN_STATUSES).toContain('duplicate_application');
    // The full vocabulary is its own answers plus the delegated RPC's.
    for (const s of SCHEDULE_PHONE_APPOINTMENT_STATUSES) {
      expect(SCHEDULE_CANDIDATE_PHONE_APPOINTMENT_STATUSES, s).toContain(s);
    }
    expect(new Set(SCHEDULE_CANDIDATE_PHONE_APPOINTMENT_STATUSES).size)
      .toBe(SCHEDULE_CANDIDATE_PHONE_APPOINTMENT_STATUSES.length);
  });

  it('duplicate_application is the literal ensure_ashby_phone_engagement answers', () => {
    expect(PHONE_DUPLICATE_APPLICATION_STATUS).toBe('duplicate_application');
    expect(functionStatuses('ensure_ashby_phone_engagement')).toContain('duplicate_application');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. due pass: one offer per line per pass
// ═══════════════════════════════════════════════════════════════════════

function standIn(digest: string): DialableNumber {
  // Deliberately NOT produced by wrapDialableNumber: no dialable-looking
  // literal is committed to this lane's tests. The due pass reads only the
  // digest, which is exactly what this stand-in carries.
  return Object.freeze({
    digest,
    toString: () => '[redacted]',
    toJSON: () => '[redacted]',
  }) as unknown as DialableNumber;
}

function dueRow(n: number, over: Partial<DuePhoneEngagement> = {}): DuePhoneEngagement {
  return {
    engagementId: `eng-${n}`,
    state: 'eligible',
    candidateId: `cand-${n}`,
    roleId: 'role-1',
    sessionId: null,
    nextEligibleAt: null,
    noAnswerAttempts: 0,
    updatedAt: new Date(NOW.getTime() - 600_000).toISOString(),
    ...over,
  };
}

function dueHarness(opts: {
  due: readonly DuePhoneEngagement[];
  /** Line digest per candidate id. */
  lines: Record<string, string>;
  /** Candidates whose session cannot be provisioned. */
  noSession?: readonly string[];
}) {
  const sessionsFor: string[] = [];
  const dialled: Array<{ engagementId: string; digest: string }> = [];
  const reader = {
    async listDueEngagements() { return opts.due; },
    async listDialableNumbers(input: { candidateIds: readonly string[] }) {
      const out = new Map<string, DialableNumber>();
      for (const id of input.candidateIds) {
        const d = opts.lines[id];
        if (d !== undefined) out.set(id, standIn(d));
      }
      return out;
    },
  } as unknown as PhoneRuntimeReader;
  const sessions: PhoneSessionPort = {
    async ensureSession(input) {
      sessionsFor.push(input.candidateId);
      return opts.noSession?.includes(input.candidateId) ? null : `session-${input.candidateId}`;
    },
  };
  const dialer: PhoneDialPort = {
    async dial(input) {
      dialled.push({ engagementId: input.engagementId, digest: input.number.digest });
      return { status: 'dialing' };
    },
  };
  const config: PhoneScreeningConfig = {
    screeningEnabled: true,
    runtimeEnabled: true,
    dialMode: 'synthetic',
    dialAllowlist: [],
    dialScope: 'allowlist',
    slotSeconds: 1_800,
    reconnectBackoffSeconds: 120,
    infraDeferBackoffSeconds: 300,
    ringTimeoutSeconds: 45,
    leaseSeconds: 180,
    webhookMaxBytes: 65_536,
    webhookToleranceSeconds: 300,
  };
  const stores: Pick<PhoneStores, 'backlog'> = {
    async backlog() {
      return {
        status: 'ok',
        admission: { controlPresent: true, halted: false, haltReason: null },
      } as Awaited<ReturnType<PhoneStores['backlog']>>;
    },
  };
  const deps: PhoneDueDeps = {
    config,
    reader,
    stores,
    sessions,
    dialer,
    async liveAppointmentStart() { return null; },
  };
  return { deps, sessionsFor, dialled };
}

describe('B. the due pass offers one engagement per LINE per pass', () => {
  it('line_already_offered is a declared skip code', () => {
    expect(PHONE_DUE_SKIPS).toContain('line_already_offered');
    // The diag summary is counts-only and unchanged by the new code.
    expect(phoneDueDiagSummary(true, 999_999, 999_999, 999_999).length).toBeLessThanOrEqual(64);
  });

  it('two candidate rows on ONE line: the first is dialled, the second skipped before any session write', async () => {
    const h = dueHarness({
      due: [dueRow(1), dueRow(2)],
      lines: { 'cand-1': 'line-a', 'cand-2': 'line-a' },
    });
    const result = await runPhoneDuePass(h.deps, { now: NOW, limit: 10, clock: () => NOW });
    expect(result.status).toBe('ok');
    expect(result.examined).toBe(2);
    expect(result.offered).toBe(1);
    expect(result.dialing).toBe(1);
    expect(result.skipped).toEqual({ line_already_offered: 1 });
    expect(h.dialled.map((d) => d.engagementId)).toEqual(['eng-1']);
    // The skipped row never minted a session.
    expect(h.sessionsFor).toEqual(['cand-1']);
  });

  it('two candidate rows on DIFFERENT lines are both dialled', async () => {
    const h = dueHarness({
      due: [dueRow(1), dueRow(2)],
      lines: { 'cand-1': 'line-a', 'cand-2': 'line-b' },
    });
    const result = await runPhoneDuePass(h.deps, { now: NOW, limit: 10, clock: () => NOW });
    expect(result.dialing).toBe(2);
    expect(result.skipped).toEqual({});
  });

  it('the line is claimed only once a session exists: a no_session row does not suppress its sibling', async () => {
    const h = dueHarness({
      due: [dueRow(1), dueRow(2)],
      lines: { 'cand-1': 'line-a', 'cand-2': 'line-a' },
      noSession: ['cand-1'],
    });
    const result = await runPhoneDuePass(h.deps, { now: NOW, limit: 10, clock: () => NOW });
    expect(result.skipped).toEqual({ no_session: 1 });
    expect(h.dialled.map((d) => d.engagementId)).toEqual(['eng-2']);
  });

  it('three rows, two lines: one skip, two dials; the result carries no digest', async () => {
    const h = dueHarness({
      due: [dueRow(1), dueRow(2), dueRow(3)],
      lines: { 'cand-1': 'line-a', 'cand-2': 'line-b', 'cand-3': 'line-a' },
    });
    const result = await runPhoneDuePass(h.deps, { now: NOW, limit: 10, clock: () => NOW });
    expect(result.dialing).toBe(2);
    expect(result.skipped).toEqual({ line_already_offered: 1 });
    expect(JSON.stringify(result)).not.toContain('line-a');
    expect(JSON.stringify(result)).not.toContain('line-b');
  });

  it('the candidate dedup still applies first (candidate_already_offered unchanged)', async () => {
    const h = dueHarness({
      due: [dueRow(1), dueRow(2, { candidateId: 'cand-1' })],
      lines: { 'cand-1': 'line-a' },
    });
    const result = await runPhoneDuePass(h.deps, { now: NOW, limit: 10, clock: () => NOW });
    expect(result.skipped).toEqual({ candidate_already_offered: 1 });
    expect(result.dialing).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. Ashby import: external_candidate_id
// ═══════════════════════════════════════════════════════════════════════

const gates: OrchestrationGates = { enabled: true, email: { providerApproved: false, domainVerified: false } };
const AI = 'stage_ai';
const mapping = (): ResolvedMapping => ({ id: 'map_1', status: 'enabled', aiScreeningStageId: AI, deliveryMode: 'manual' });
function reader(app: Record<string, unknown>): ApplicationReader {
  return {
    applicationInfo: (async () => ({ results: app, moreDataAvailable: false })) as ApplicationReader['applicationInfo'],
  };
}

class CapturingStores implements WorkflowStores {
  seeded: ExistingLinkRow | null = null;
  created: Array<Record<string, unknown>> = [];
  bound: Array<{ linkId: string; value: string }> = [];
  async findLinkByApplicationId(): Promise<ExistingLinkRow | null> { return this.seeded; }
  async createLink(input: Parameters<WorkflowStores['createLink']>[0]): Promise<{ id: string }> {
    this.created.push({ ...input });
    return { id: 'link_new' };
  }
  async bindLinkExternalCandidateId(linkId: string, value: string): Promise<void> {
    this.bound.push({ linkId, value });
  }
  async advanceIngestion(): Promise<{ status: string }> { return { status: 'ok' }; }
  async enqueueOperation(): Promise<EnqueueResult> { return { status: 'inserted', id: 'op_1' }; }
  async completeOperation(): Promise<'ok'> { return 'ok'; }
  async failOperation(): Promise<{ outcome: 'retry' }> { return { outcome: 'retry' }; }
}

const appWithCandidate = {
  application: { id: 'app_1', job: { id: 'job_1' }, candidate: { id: 'ashby_cand_1' }, currentInterviewStage: { id: AI } },
};
const appWithoutCandidate = {
  application: { id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: AI } },
};

describe('C. Ashby import writes and backfills external_candidate_id', () => {
  it('a new link carries the opaque Ashby candidate id', async () => {
    const stores = new CapturingStores();
    const r = await runImport('app_1', { gates, client: reader(appWithCandidate), stores, resolveMapping: async () => mapping() });
    expect(r.status).toBe('imported');
    expect(stores.created).toHaveLength(1);
    expect(stores.created[0].externalCandidateId).toBe('ashby_cand_1');
    expect(stores.bound).toEqual([]);
  });

  it('a new link with no candidate in the payload writes null', async () => {
    const stores = new CapturingStores();
    await runImport('app_1', { gates, client: reader(appWithoutCandidate), stores, resolveMapping: async () => mapping() });
    expect(stores.created[0].externalCandidateId).toBeNull();
  });

  it('a reused link with none stored is backfilled', async () => {
    const stores = new CapturingStores();
    stores.seeded = { id: 'link_x', externalApplicationId: 'app_1', terminalState: null, externalCandidateId: null };
    await runImport('app_1', { gates, client: reader(appWithCandidate), stores, resolveMapping: async () => mapping() });
    expect(stores.created).toEqual([]);
    expect(stores.bound).toEqual([{ linkId: 'link_x', value: 'ashby_cand_1' }]);
  });

  it('a reused link that already has one is never rewritten, and no candidate means no backfill', async () => {
    const has = new CapturingStores();
    has.seeded = { id: 'link_x', externalApplicationId: 'app_1', terminalState: null, externalCandidateId: 'ashby_cand_old' };
    await runImport('app_1', { gates, client: reader(appWithCandidate), stores: has, resolveMapping: async () => mapping() });
    expect(has.bound).toEqual([]);

    const none = new CapturingStores();
    none.seeded = { id: 'link_x', externalApplicationId: 'app_1', terminalState: null };
    await runImport('app_1', { gates, client: reader(appWithoutCandidate), stores: none, resolveMapping: async () => mapping() });
    expect(none.bound).toEqual([]);
  });
});

/** A recording PostgREST double: every builder call is captured in order. */
function recordingClient(answer: { data: unknown; error: unknown }) {
  const ops: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['insert', 'update', 'select', 'eq', 'is', 'limit', 'single', 'maybeSingle']) {
    builder[m] = (...args: unknown[]) => { ops.push([m, ...args]); return builder; };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve);
  const client = {
    from(table: string) { ops.push(['from', table]); return builder; },
    rpc() { throw new Error('unexpected rpc'); },
  } as unknown as SupabaseClient;
  return { client, ops };
}

describe('C. the workflow store persists it with a compare-and-set', () => {
  it('createLink inserts external_candidate_id (null when absent)', async () => {
    const withId = recordingClient({ data: { id: 'link_1' }, error: null });
    await createWorkflowStores(withId.client).createLink({
      externalApplicationId: 'app_1', externalJobId: 'job_1', externalStageId: AI,
      jobMappingId: 'map_1', externalResumeFileHandle: null, submittedAt: null,
      externalCandidateId: 'ashby_cand_1',
    });
    const insert = withId.ops.find((o) => o[0] === 'insert')![1] as Record<string, unknown>;
    expect(insert.external_candidate_id).toBe('ashby_cand_1');

    const without = recordingClient({ data: { id: 'link_1' }, error: null });
    await createWorkflowStores(without.client).createLink({
      externalApplicationId: 'app_1', externalJobId: 'job_1', externalStageId: AI,
      jobMappingId: 'map_1', externalResumeFileHandle: null, submittedAt: null,
    });
    const insert2 = without.ops.find((o) => o[0] === 'insert')![1] as Record<string, unknown>;
    expect(insert2.external_candidate_id).toBeNull();
  });

  it('bindLinkExternalCandidateId updates only where the column IS NULL', async () => {
    const rc = recordingClient({ data: null, error: null });
    await createWorkflowStores(rc.client).bindLinkExternalCandidateId!('link_1', 'ashby_cand_1');
    expect(rc.ops).toContainEqual(['from', 'ashby_application_links']);
    expect(rc.ops).toContainEqual(['update', { external_candidate_id: 'ashby_cand_1' }]);
    expect(rc.ops).toContainEqual(['eq', 'id', 'link_1']);
    expect(rc.ops).toContainEqual(['is', 'external_candidate_id', null]);
  });

  it('a backfill failure throws a bare code that carries no value', async () => {
    const rc = recordingClient({ data: null, error: { message: 'boom' } });
    await expect(createWorkflowStores(rc.client).bindLinkExternalCandidateId!('link_1', 'ashby_cand_secret'))
      .rejects.toThrow(/^ashby_link_candidate_id_backfill_error$/);
  });

  it('findLinkByApplicationId surfaces the stored id so reuse can decide', async () => {
    const rc = recordingClient({
      data: {
        id: 'link_1', external_application_id: 'app_1', terminal_state: null,
        external_resume_file_handle: null, external_candidate_id: 'ashby_cand_1',
      },
      error: null,
    });
    const row = await createWorkflowStores(rc.client).findLinkByApplicationId('app_1');
    expect(row?.externalCandidateId).toBe('ashby_cand_1');
    const select = rc.ops.find((o) => o[0] === 'select')![1] as string;
    expect(select).toContain('external_candidate_id');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. routes
// ═══════════════════════════════════════════════════════════════════════

/** Per-table chainable answer; records every filter applied. */
function tableChain(value: unknown, filters: Array<[string, ...unknown[]]>): any {
  const fn: any = function () { return tableChain(value, filters); };
  fn.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle', 'single', 'gt', 'gte', 'lt', 'lte', 'neq']) {
    fn[m] = (...args: unknown[]) => { filters.push([m, ...args]); return tableChain(value, filters); };
  }
  return fn;
}

let mockFrom: any;
let mockRpc: any;
let originalSink: ReturnType<typeof getAuditSink>;
let audited: AuditEntry[];
let engagementFilters: Array<[string, ...unknown[]]>;

function tables(over: { candidates?: unknown; phone_engagements?: unknown } = {}) {
  engagementFilters = [];
  mockFrom.mockImplementation((table: string) => {
    if (table === 'candidates') {
      return tableChain(over.candidates ?? { data: { id: CANDIDATE_ID, owner_id: ACTOR_ID }, error: null }, []);
    }
    if (table === 'phone_engagements') {
      return tableChain(over.phone_engagements ?? { data: [{ id: ENGAGEMENT_ID }], error: null }, engagementFilters);
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(async () => {
  process.env.PHONE_SCREENING_ENABLED = 'true';
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockRpc = (mod.supabase as any).rpc;
  mockFrom.mockReset();
  mockRpc.mockReset();
  originalSink = getAuditSink();
  audited = [];
  setAuditSink((entry) => { audited.push(entry); });
});

afterEach(() => {
  setAuditSink(originalSink);
  delete process.env.PHONE_SCREENING_ENABLED;
});

function makeApp(user: { id?: string; appRole: 'admin' | 'interviewer' | 'viewer' } | null = { id: ACTOR_ID, appRole: 'admin' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { authUser: unknown }).authUser = user;
    next();
  });
  app.use('/api/candidates', candidatesRouter);
  app.use(finalErrorHandler);
  return app;
}

const RELEASE = `/api/candidates/${CANDIDATE_ID}/phone/release-duplicate-hold`;

describe('D. the manual request and the booking answer 409 duplicate_application', () => {
  it('POST /phone-call: a held engagement is a distinct 409, not phone_request_refused', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: { status: 'duplicate_application', engagement_id: ENGAGEMENT_ID }, error: null });
    const res = await request(makeApp()).post(`/api/candidates/${CANDIDATE_ID}/phone-call`).send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'duplicate_application', status: 'duplicate_application' });
    // The engagement id of the OTHER row is never in the body; nor is this one.
    expect(JSON.stringify(res.body)).not.toContain(ENGAGEMENT_ID);
  });

  it('POST /phone-call: other refusals keep phone_request_refused', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: { status: 'consent_not_granted' }, error: null });
    const res = await request(makeApp()).post(`/api/candidates/${CANDIDATE_ID}/phone-call`).send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('phone_request_refused');
  });

  it('POST /phone-appointments: duplicate_application is a 409 with that code and books nothing else', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: { status: 'duplicate_application', engagement_id: ENGAGEMENT_ID }, error: null });
    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-appointments`)
      .send({ starts_at: '2026-10-04T05:30:00.000Z', ends_at: '2026-10-04T06:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'duplicate_application' });
    expect(mockRpc.mock.calls.map((c: unknown[]) => c[0])).toEqual(['schedule_candidate_phone_appointment']);
  });
});

describe('D. POST /candidates/:id/phone/release-duplicate-hold', () => {
  it('releases the one held engagement, resolved server-side, and audits it', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({
      data: { status: 'ok', engagement_id: ENGAGEMENT_ID, prerequisite_status: 'eligible' },
      error: null,
    });
    const res = await request(makeApp()).post(RELEASE).send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, status: 'released', engagement_id: ENGAGEMENT_ID, prerequisite_status: 'eligible',
    });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [name, args] = mockRpc.mock.calls[0];
    expect(name).toBe('release_phone_identity_hold');
    expect(Object.keys(args)).toEqual([...PHONE_IDENTITY_RPC_PARAMETERS.release_phone_identity_hold]);
    expect(args.p_engagement_id).toBe(ENGAGEMENT_ID);
    expect(args.p_actor_id).toBe(ACTOR_ID);
    // The lookup is scoped to THIS candidate's held, non-terminal engagements.
    expect(engagementFilters).toContainEqual(['eq', 'candidate_id', CANDIDATE_ID]);
    expect(engagementFilters).toContainEqual(['eq', 'state', 'pending_prereqs']);
    expect(engagementFilters).toContainEqual(['eq', 'state_reason', 'duplicate_application']);
    expect(engagementFilters).toContainEqual(['is', 'terminal_at', null]);
    expect(audited.some((e) => (e.metadata as Record<string, unknown> | undefined)?.resource === 'phone_identity_hold')).toBe(true);
  });

  it('requires the explicit confirmation body', async () => {
    tables();
    const res = await request(makeApp()).post(RELEASE).send({});
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('is refused when phone screening is disabled', async () => {
    delete process.env.PHONE_SCREENING_ENABLED;
    tables();
    const res = await request(makeApp()).post(RELEASE).send({ confirm: true });
    expect(res.status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a viewer is forbidden; an interviewer who does not own the candidate gets 404', async () => {
    tables();
    const viewer = await request(makeApp({ id: ACTOR_ID, appRole: 'viewer' })).post(RELEASE).send({ confirm: true });
    expect(viewer.status).toBe(403);

    tables({ candidates: { data: null, error: null } });
    const stranger = await request(makeApp({ id: ACTOR_ID, appRole: 'interviewer' })).post(RELEASE).send({ confirm: true });
    expect(stranger.status).toBe(404);
    expect(stranger.body.error).toBe('candidate_not_found');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('no held engagement: 409 phone_hold_not_held with no RPC', async () => {
    tables({ phone_engagements: { data: [], error: null } });
    const res = await request(makeApp()).post(RELEASE).send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('phone_hold_not_held');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('two held engagements: refused as ambiguous, never guessed', async () => {
    tables({ phone_engagements: { data: [{ id: ENGAGEMENT_ID }, { id: OTHER_ENGAGEMENT_ID }], error: null } });
    const res = await request(makeApp()).post(RELEASE).send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'phone_hold_ambiguous' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['not_held', 409, 'phone_hold_not_held'],
    ['not_found', 404, 'phone_hold_not_found'],
    ['actor_required', 403, 'actor_required'],
    ['invalid_request', 500, 'phone_rpc_unknown_status'],
    ['some_future_status', 500, 'phone_rpc_unknown_status'],
  ])('RPC %s maps to %i %s', async (status, http, error) => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: { status }, error: null });
    const res = await request(makeApp()).post(RELEASE).send({ confirm: true });
    expect(res.status).toBe(http);
    expect(res.body).toEqual({ ok: false, error });
  });

  it('an RPC transport error or a lookup error is 503', async () => {
    tables();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    expect((await request(makeApp()).post(RELEASE).send({ confirm: true })).status).toBe(503);

    tables({ phone_engagements: { data: null, error: { message: 'down' } } });
    const res = await request(makeApp()).post(RELEASE).send({ confirm: true });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('phone_release_unavailable');
  });

  it('an unattributable caller is refused before any read', async () => {
    tables();
    const res = await request(makeApp({ appRole: 'admin' })).post(RELEASE).send({ confirm: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('actor_required');
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// E. the health count read
// ═══════════════════════════════════════════════════════════════════════

describe('E. countDuplicateApplicationHolds is a bounded, id-only count over held, live engagements', () => {
  it('reads only ids, scoped to the duplicate_application reason and non-terminal rows, and returns only the count', async () => {
    const rc = recordingClient({ data: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }], error: null });
    const n = await createPhoneReadStore(rc.client).countDuplicateApplicationHolds!();
    expect(n).toBe(3);
    expect(rc.ops).toContainEqual(['from', 'phone_engagements']);
    expect(rc.ops).toContainEqual(['select', 'id']);
    expect(rc.ops).toContainEqual(['eq', 'state_reason', 'duplicate_application']);
    expect(rc.ops).toContainEqual(['is', 'terminal_at', null]);
    expect(rc.ops.some((o) => o[0] === 'limit')).toBe(true);
  });

  it('throws a bare code on an error or a malformed answer, so health reports null rather than 0', async () => {
    const failed = recordingClient({ data: null, error: { message: 'x' } });
    await expect(createPhoneReadStore(failed.client).countDuplicateApplicationHolds!())
      .rejects.toThrow(/^phone_engagement_read_error$/);
    const malformed = recordingClient({ data: null, error: null });
    await expect(createPhoneReadStore(malformed.client).countDuplicateApplicationHolds!())
      .rejects.toThrow(/^phone_engagement_read_error$/);
  });

  it('the reason is held only on pending_prereqs rows, which is why no state filter is needed', () => {
    // Every write of the reason in ensure is on the pending_prereqs branch,
    // and leaving that state either clears it (eligible) or is terminal.
    const ensure = functionBody('ensure_ashby_phone_engagement');
    const writes = [...ensure.matchAll(/state_reason = 'duplicate_application'/g)];
    expect(writes.length).toBe(1);
    expect(ensure).toMatch(/set state = 'eligible', state_reason = null/);
  });

  it('the route module restates the two §6 vocabularies exactly as rpc-contract declares them', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../routes/candidates.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('phone-screening');
    expect(src).toContain(`const PHONE_DUPLICATE_APPLICATION_STATUS = '${PHONE_DUPLICATE_APPLICATION_STATUS}';`);
    const m = /const RELEASE_PHONE_IDENTITY_HOLD_STATUSES: readonly string\[\] = \[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    const restated = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(restated).toEqual([...RELEASE_PHONE_IDENTITY_HOLD_STATUSES]);
  });
});
