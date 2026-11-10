/**
 * The Ashby stage catalogue (M031 S2): the default milestone rules, the plan
 * read, and the refresh.
 *
 * Zero network: the Ashby reader is a fake, and the catalogue store is an
 * in-memory copy of refresh_ashby_stage_catalog's rules (0138), whose real
 * behaviour is asserted on Postgres in app/supabase/tests/policy_tests.sql.
 * The fixture is the live plan every mapped job shares (BUSINESS-IMPACT-PLAN.md,
 * "Live checks"): 18 stages, New Lead to Hired.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ASHBY_OPERATIONS, type AshbyOperation } from '../integrations/ashby/types.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import {
  MAX_REFRESH_JOBS,
  STAGE_CATALOG_READ_OPERATIONS,
  STAGE_MILESTONES,
  assertStageCatalogReadOnly,
  createStageCatalogStore,
  defaultMilestone,
  isStageMilestone,
  readPlanStages,
  runStageCatalogRefresh,
  type MilestoneSource,
  type StageCatalogStore,
  type StageCatalogTargets,
  type StageCatalogUpsert,
  type StageMilestone,
  type StoredStage,
} from '../integrations/ashby/stage-catalog.js';
import { LIVE_STAGES } from './support/ashby-live-stages.js';

const PLAN = 'plan-shared-0001';
const CHRISTY = 'stage-05-christy';
const ADMIN = '44444444-4444-4444-8444-444444444444';


const EXPECTED_DEFAULTS: Record<string, StageMilestone | null> = {
  'New Lead': null, 'Reached Out': null, Replied: null, 'Application Review': null,
  'Hello Christy': 'christy', 'TA Screen': null, 'HM Review': null, 'R0 - Online Assessment': null,
  R1: 'r1', R2: 'r2', R3: 'r3', R4: 'r4', R5: 'r5', 'Reference Check': 'reference',
  'Document Submission': null, Offer: 'offer', Archived: 'archived', Hired: 'hired',
};

/** What jobInterviewPlan.info answers, with fields the catalogue must never copy. */
function planPayload(stages = LIVE_STAGES) {
  return {
    jobId: 'job-a',
    interviewPlanId: PLAN,
    hiringTeam: [{ email: 'recruiter@example.com', name: 'A Recruiter' }],
    stages: stages.map((s, i) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      orderInInterviewPlan: i,
      interviewStageGroupId: s.type === 'Active' ? 'grp-interviews' : null,
      interviewPlanId: PLAN,
      interviewers: [{ email: 'interviewer@example.com' }],
      candidateEmail: 'candidate@example.com',
    })),
  };
}

function fakeReader(payloadFor: (jobId: string) => unknown = () => planPayload()) {
  return {
    jobInterviewPlanInfo: vi.fn(async (jobId: string) => ({ results: payloadFor(jobId) as never })),
  };
}

/** An in-memory catalogue that applies the 0138 refresh rules. */
function memoryStore(targets: StageCatalogTargets) {
  const rows = new Map<string, StoredStage>();
  const writes: StageCatalogUpsert[][] = [];
  const store: StageCatalogStore = {
    readTargets: vi.fn(async () => targets),
    writeStages: vi.fn(async (stages: StageCatalogUpsert[], _actorId: string) => {
      writes.push(stages);
      let inserted = 0;
      let updated = 0;
      let defaulted = 0;
      let redefaulted = 0;
      for (const s of stages) {
        const had = rows.get(s.stageId);
        if (!had) {
          rows.set(s.stageId, {
            stageId: s.stageId, interviewPlanId: s.interviewPlanId, title: s.title, stageType: s.stageType,
            orderInPlan: s.orderInPlan, stageGroupId: s.stageGroupId, source: 'plan', inPlan: true,
            milestone: s.defaultMilestone, milestoneSource: s.defaultMilestone ? 'default' : null,
          });
          inserted += 1;
          if (s.defaultMilestone) defaulted += 1;
          continue;
        }
        updated += 1;
        // An admin label stays; any other label is the rules' answer today.
        const admin = had.milestoneSource === 'admin';
        if (!admin && had.milestone !== s.defaultMilestone) {
          if (had.milestone === null) defaulted += 1;
          else redefaulted += 1;
        }
        rows.set(s.stageId, {
          ...had,
          interviewPlanId: s.interviewPlanId ?? had.interviewPlanId,
          title: s.title ?? had.title,
          stageType: s.stageType ?? had.stageType,
          orderInPlan: s.orderInPlan ?? had.orderInPlan,
          stageGroupId: s.stageGroupId ?? had.stageGroupId,
          source: 'plan',
          inPlan: true,
          milestone: admin ? had.milestone : s.defaultMilestone,
          milestoneSource: admin ? 'admin' : s.defaultMilestone ? 'default' : null,
        });
      }
      // A plan this write names no longer lists these stages: kept, marked.
      const plans = new Set(stages.map((s) => s.interviewPlanId).filter((id): id is string => id !== null));
      const written = new Set(stages.map((s) => s.stageId));
      let leftPlan = 0;
      for (const [id, row] of rows) {
        if (row.inPlan && row.interviewPlanId !== null && plans.has(row.interviewPlanId) && !written.has(id)) {
          rows.set(id, { ...row, inPlan: false });
          leftPlan += 1;
        }
      }
      return { inserted, updated, defaulted, redefaulted, leftPlan };
    }),
    listForEnabledPlans: vi.fn(async () => ({ enabledMappings: 0, unreadMappings: 0, truncated: false, stages: [] })),
    readStage: vi.fn(async (id: string) => rows.get(id) ?? null),
    setMilestone: vi.fn(async (id: string, milestone: StageMilestone | null, source: MilestoneSource | null, _actorId: string) => {
      const had = rows.get(id);
      if (!had) return null;
      const next = { ...had, milestone, milestoneSource: source };
      rows.set(id, next);
      return { from: had.milestone, stage: next };
    }),
  };
  return { store, rows, writes };
}

const TARGETS: StageCatalogTargets = {
  enabledMappings: 3,
  jobIds: ['job-a', 'job-b', 'job-c'],
  christyStageIds: [CHRISTY],
  truncated: false,
};

describe('read-only by construction', () => {
  it('may perform only jobInterviewPlan.info, and that is a registry read', () => {
    expect([...STAGE_CATALOG_READ_OPERATIONS]).toEqual(['jobInterviewPlan.info']);
    expect(ASHBY_OPERATIONS['jobInterviewPlan.info'].mutation).toBe(false);
    expect(() => assertStageCatalogReadOnly('jobInterviewPlan.info')).not.toThrow();
  });

  it.each(Object.keys(ASHBY_OPERATIONS).filter((op) => op !== 'jobInterviewPlan.info'))('refuses %s', (op) => {
    expect(() => assertStageCatalogReadOnly(op as AshbyOperation)).toThrow('ashby_stage_catalog_operation_not_allowed');
  });

  it('the module imports no write seam and its store never deletes', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../integrations/ashby/stage-catalog.ts'), 'utf8');
    expect(source).not.toMatch(/\.delete\(/);
    expect(source).not.toMatch(/\.from\('(ashby_application_links|candidates|assessments)'\)\s*\.(insert|update|upsert|delete)/);
    expect(source).not.toMatch(/mutation:\s*true/);
    for (const op of Object.entries(ASHBY_OPERATIONS).filter(([, spec]) => spec.mutation).map(([name]) => name)) {
      expect(source).not.toContain(`'${op}'`);
    }
  });
});

describe('the milestone vocabulary', () => {
  it('is the allowed set, in the order the API offers it', () => {
    expect([...STAGE_MILESTONES]).toEqual(['christy', 'r1', 'r2', 'r3', 'r4', 'r5', 'reference', 'offer', 'hired', 'archived', 'other']);
  });

  it.each([...STAGE_MILESTONES])('accepts %s', (m) => expect(isStageMilestone(m)).toBe(true));
  it.each(['R1', 'r6', 'r0', 'Offer', '', ' r1', 'christy ', 'hello christy', null, undefined, 1, {}])('refuses %j', (m) => {
    expect(isStageMilestone(m)).toBe(false);
  });
});

describe('default milestones', () => {
  const christy = new Set([CHRISTY]);

  it('label the 18 live stages exactly as the plan says', () => {
    const got = Object.fromEntries(LIVE_STAGES.map((s) => [s.title, defaultMilestone({ id: s.id, type: s.type, title: s.title }, christy)]));
    expect(got).toEqual(EXPECTED_DEFAULTS);
  });

  it("the mapping's Christy stage is christy, whatever its type or title", () => {
    expect(defaultMilestone({ id: CHRISTY, type: 'Active', title: 'R1' }, christy)).toBe('christy');
    expect(defaultMilestone({ id: CHRISTY, type: null, title: null }, christy)).toBe('christy');
    expect(defaultMilestone({ id: 'other-stage', type: 'PreInterviewScreen', title: 'Hello Christy' }, christy)).toBeNull();
  });

  it.each([
    ['Offer', 'offer'], ['Hired', 'hired'], ['Archived', 'archived'],
  ] as const)('type %s is %s, whatever the title', (type, milestone) => {
    expect(defaultMilestone({ id: 's', type, title: 'Anything at all' }, christy)).toBe(milestone);
    expect(defaultMilestone({ id: 's', type, title: null }, christy)).toBe(milestone);
  });

  it.each([
    ['R1', 'r1'], ['r2', 'r2'], [' R3 ', 'r3'], ['\tr4\n', 'r4'], ['R5', 'r5'],
  ] as const)('an Active stage titled %j is %s (trimmed, any case)', (title, milestone) => {
    expect(defaultMilestone({ id: 's', type: 'Active', title }, christy)).toBe(milestone);
  });

  it.each(['R0 - Online Assessment', 'R0', 'R6', 'R1 - Technical', 'Round 1', 'R 1', 'R1R2', 'R10', 'HM Review', ''])(
    'an Active stage titled %j has no default',
    (title) => expect(defaultMilestone({ id: 's', type: 'Active', title }, christy)).toBeNull(),
  );

  it.each(['PreInterviewScreen', 'Lead', 'SomethingNew', null])('R1 on a %s stage has no default: only Active stages', (type) => {
    expect(defaultMilestone({ id: 's', type, title: 'R1' }, christy)).toBeNull();
  });

  it.each(['Reference Check', 'reference check', '  Reference Check  ', 'REFERENCE CHECK'])('%j is reference', (title) => {
    expect(defaultMilestone({ id: 's', type: 'Active', title }, christy)).toBe('reference');
  });

  it.each(['Reference Checks', 'Reference', 'Ref Check', 'Reference  Check'])('%j has no default', (title) => {
    expect(defaultMilestone({ id: 's', type: 'Active', title }, christy)).toBeNull();
  });

  it('never defaults to other: an unknown stage stays unlabelled', () => {
    for (const s of LIVE_STAGES) expect(defaultMilestone({ id: s.id, type: s.type, title: s.title }, christy)).not.toBe('other');
  });
});

describe('reading a plan', () => {
  it('copies only the stage fields and the plan id, in plan order', () => {
    const stages = readPlanStages(planPayload());
    expect(stages).toHaveLength(18);
    expect(stages[0]).toEqual({
      stageId: 'stage-01-lead', interviewPlanId: PLAN, title: 'New Lead', stageType: 'Lead', orderInPlan: 0, stageGroupId: null,
    });
    expect(stages[8]).toEqual({
      stageId: 'stage-09-r1', interviewPlanId: PLAN, title: 'R1', stageType: 'Active', orderInPlan: 8, stageGroupId: 'grp-interviews',
    });
    const text = JSON.stringify(stages);
    for (const leak of ['example.com', 'Recruiter', 'interviewers', 'hiringTeam', 'job-a']) expect(text).not.toContain(leak);
  });

  it('takes the plan id from a stage when the envelope has none', () => {
    const payload = planPayload();
    const { interviewPlanId: _drop, ...rest } = payload;
    expect(readPlanStages(rest)[0].interviewPlanId).toBe(PLAN);
  });

  it('a position past a Postgres integer is unusable, not a failed write', () => {
    const stages = readPlanStages({ stages: [{ id: 'far', orderInInterviewPlan: 2_147_483_648 }, { id: 'edge', orderInInterviewPlan: 2_147_483_647 }] });
    expect(stages.map((s) => s.orderInPlan)).toEqual([null, 2_147_483_647]);
  });

  it('keeps a stage whose title, type or order is unusable, with nulls', () => {
    const stages = readPlanStages({ stages: [{ id: 'odd', title: '‮​', type: 'has space', orderInInterviewPlan: -1 }] });
    expect(stages).toEqual([{ stageId: 'odd', interviewPlanId: null, title: null, stageType: null, orderInPlan: null, stageGroupId: null }]);
  });
});

describe('the refresh', () => {
  it('writes as the admin whose request ran it: the store audits the write in the same transaction (S2-3)', async () => {
    const { store } = memoryStore(TARGETS);
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    expect(store.writeStages).toHaveBeenCalledWith(expect.any(Array), ADMIN);
  });

  it('reads each enabled job once, writes each shared stage once with its default', async () => {
    const reader = fakeReader();
    const { store, writes } = memoryStore(TARGETS);
    const result = await runStageCatalogRefresh(reader, store, { actorId: ADMIN });
    expect(reader.jobInterviewPlanInfo.mock.calls.map((c) => c[0])).toEqual(['job-a', 'job-b', 'job-c']);
    expect(writes).toHaveLength(1);
    expect(writes[0].map((s) => s.stageId)).toEqual(LIVE_STAGES.map((s) => s.id));
    expect(Object.fromEntries(writes[0].map((s) => [s.title, s.defaultMilestone]))).toEqual(EXPECTED_DEFAULTS);
    expect(result).toEqual({
      mappings: { enabled: 3, truncated: false },
      jobs: { attempted: 3, read: 3, failed: 0, notTried: 0 },
      failures: [],
      stages: { seen: 18, inserted: 18, updated: 0, defaulted: 10, redefaulted: 0, leftPlan: 0 },
      deadlineHit: false,
    });
  });

  it('is idempotent: a second run inserts and defaults nothing and leaves every row as it was', async () => {
    const { store, rows } = memoryStore(TARGETS);
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    const before = structuredClone([...rows.entries()]);
    const again = await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    expect(again.stages).toEqual({ seen: 18, inserted: 0, updated: 18, defaulted: 0, redefaulted: 0, leftPlan: 0 });
    expect([...rows.entries()]).toEqual(before);
  });

  it('a stage Ashby removes is kept with its label and marked as no longer in the plan (S2-4)', async () => {
    const { store, rows } = memoryStore(TARGETS);
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    const plan = LIVE_STAGES.map((s) => (s.id === 'stage-13-r5' ? { id: 'stage-13b-panel', title: 'Panel', type: 'Active' } : s));
    const result = await runStageCatalogRefresh(fakeReader(() => planPayload(plan)), store, { actorId: ADMIN });
    expect(result.stages).toEqual({ seen: 18, inserted: 1, updated: 17, defaulted: 0, redefaulted: 0, leftPlan: 1 });
    expect(rows.get('stage-13-r5')).toMatchObject({ inPlan: false, milestone: 'r5', milestoneSource: 'default', orderInPlan: 12 });
    expect(rows.get('stage-13b-panel')).toMatchObject({ inPlan: true, orderInPlan: 12 });
    // A plan read that failed judges nothing.
    const failing = fakeReader();
    failing.jobInterviewPlanInfo.mockRejectedValue(new AshbyError('http_client_error', { httpStatus: 403 }));
    await runStageCatalogRefresh(failing, store, { actorId: ADMIN });
    expect([...rows.values()].filter((r) => !r.inPlan).map((r) => r.stageId)).toEqual(['stage-13-r5']);
  });

  it('never overwrites an admin label, and never deletes a stage the plan dropped', async () => {
    const { store, rows } = memoryStore(TARGETS);
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    rows.set('stage-09-r1', { ...rows.get('stage-09-r1')!, milestone: 'r2', milestoneSource: 'admin' });
    rows.set('stage-07-hm', { ...rows.get('stage-07-hm')!, milestone: 'other', milestoneSource: 'admin' });
    const smaller = LIVE_STAGES.filter((s) => s.id !== 'stage-15-docs');
    await runStageCatalogRefresh(fakeReader(() => planPayload(smaller)), store, { actorId: ADMIN });
    expect(rows.get('stage-09-r1')).toMatchObject({ milestone: 'r2', milestoneSource: 'admin' });
    expect(rows.get('stage-07-hm')).toMatchObject({ milestone: 'other', milestoneSource: 'admin' });
    expect(rows.has('stage-15-docs')).toBe(true);
    expect(rows.size).toBe(18);
  });

  it('a stage Ashby renames away from R2 loses its default label, and the new R2 takes it (S2-2)', async () => {
    const { store, rows } = memoryStore(TARGETS);
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    rows.set('stage-11-r3', { ...rows.get('stage-11-r3')!, milestone: 'other', milestoneSource: 'admin' });
    const renamed = LIVE_STAGES.map((s) => (s.id === 'stage-10-r2' ? { ...s, title: 'Assignment' } : s.id === 'stage-11-r3' ? { ...s, title: 'Panel' } : s));
    const plan = [...renamed.slice(0, 10), { id: 'stage-10b-r2', title: 'R2', type: 'Active' }, ...renamed.slice(10)];
    const result = await runStageCatalogRefresh(fakeReader(() => planPayload(plan)), store, { actorId: ADMIN });
    expect(rows.get('stage-10-r2')).toMatchObject({ title: 'Assignment', milestone: null, milestoneSource: null });
    expect(rows.get('stage-10b-r2')).toMatchObject({ title: 'R2', milestone: 'r2', milestoneSource: 'default' });
    expect([...rows.values()].filter((r) => r.milestone === 'r2')).toHaveLength(1);
    // An admin label never moves, whatever Ashby renames.
    expect(rows.get('stage-11-r3')).toMatchObject({ title: 'Panel', milestone: 'other', milestoneSource: 'admin' });
    expect(result.stages).toEqual({ seen: 19, inserted: 1, updated: 18, defaulted: 1, redefaulted: 1, leftPlan: 0 });
  });

  it('a stage Ashby retypes takes the default of its new type (S2-2)', async () => {
    const { store, rows } = memoryStore(TARGETS);
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    const plan = LIVE_STAGES.map((s) => (s.id === 'stage-12-r4' ? { ...s, title: 'Offer Call', type: 'Offer' } : s));
    const result = await runStageCatalogRefresh(fakeReader(() => planPayload(plan)), store, { actorId: ADMIN });
    expect(rows.get('stage-12-r4')).toMatchObject({ title: 'Offer Call', stageType: 'Offer', milestone: 'offer', milestoneSource: 'default' });
    expect(result.stages).toMatchObject({ defaulted: 0, redefaulted: 1 });
  });

  it("a mapping's Christy stage that moves takes christy with it (S2-2)", async () => {
    const targets: StageCatalogTargets = { ...TARGETS, christyStageIds: [CHRISTY] };
    const { store, rows } = memoryStore(targets);
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    targets.christyStageIds = ['stage-06-ta'];
    const result = await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    expect(rows.get(CHRISTY)).toMatchObject({ milestone: null, milestoneSource: null });
    expect(rows.get('stage-06-ta')).toMatchObject({ milestone: 'christy', milestoneSource: 'default' });
    expect([...rows.values()].filter((r) => r.milestone === 'christy')).toHaveLength(1);
    expect(result.stages).toMatchObject({ defaulted: 1, redefaulted: 1 });
  });

  it('passes the default for every stage, so the store alone decides whether a label is already set', async () => {
    const { store, writes } = memoryStore(TARGETS);
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    await runStageCatalogRefresh(fakeReader(), store, { actorId: ADMIN });
    expect(writes[1]).toEqual(writes[0]);
  });

  it('a job Ashby refuses is counted by code; the other jobs still refresh', async () => {
    const reader = fakeReader();
    reader.jobInterviewPlanInfo.mockImplementation(async (jobId: string) => {
      if (jobId === 'job-b') throw new AshbyError('http_client_error', { httpStatus: 403, endpointCodes: ['missing_endpoint_permission'] });
      if (jobId === 'job-c') throw new AshbyError('retry_exhausted', { code: 'timeout' });
      return { results: planPayload() as never };
    });
    const { store } = memoryStore(TARGETS);
    const result = await runStageCatalogRefresh(reader, store, { actorId: ADMIN });
    expect(result.jobs).toEqual({ attempted: 3, read: 1, failed: 2, notTried: 0 });
    expect(result.failures).toEqual([{ code: 'missing_permission', count: 1 }, { code: 'timeout', count: 1 }]);
    expect(result.stages.seen).toBe(18);
  });

  it('writes nothing when no plan could be read', async () => {
    const reader = fakeReader();
    reader.jobInterviewPlanInfo.mockRejectedValue(new AshbyError('http_client_error', { httpStatus: 403 }));
    const { store } = memoryStore(TARGETS);
    const result = await runStageCatalogRefresh(reader, store, { actorId: ADMIN });
    expect(store.writeStages).not.toHaveBeenCalled();
    expect(result.failures).toEqual([{ code: 'forbidden', count: 3 }]);
    expect(result.stages).toEqual({ seen: 0, inserted: 0, updated: 0, defaulted: 0, redefaulted: 0, leftPlan: 0 });
  });

  it('makes no Ashby call when no mapping is enabled', async () => {
    const reader = fakeReader();
    const { store } = memoryStore({ enabledMappings: 0, jobIds: [], christyStageIds: [], truncated: false });
    const result = await runStageCatalogRefresh(reader, store, { actorId: ADMIN });
    expect(reader.jobInterviewPlanInfo).not.toHaveBeenCalled();
    expect(store.writeStages).not.toHaveBeenCalled();
    expect(result.jobs).toEqual({ attempted: 0, read: 0, failed: 0, notTried: 0 });
  });

  it(`reads at most ${MAX_REFRESH_JOBS} jobs and says the list was cut`, async () => {
    const jobIds = Array.from({ length: MAX_REFRESH_JOBS + 2 }, (_, i) => `job-${i}`);
    const reader = fakeReader();
    const { store } = memoryStore({ ...TARGETS, enabledMappings: jobIds.length, jobIds });
    const result = await runStageCatalogRefresh(reader, store, { actorId: ADMIN });
    expect(reader.jobInterviewPlanInfo).toHaveBeenCalledTimes(MAX_REFRESH_JOBS);
    expect(result.mappings.truncated).toBe(true);
  });

  it('skips a job id that is not identifier-shaped, without calling Ashby for it', async () => {
    const reader = fakeReader();
    const { store } = memoryStore({ ...TARGETS, jobIds: ['job-a', 'not an id', 'job-a'] });
    await runStageCatalogRefresh(reader, store, { actorId: ADMIN });
    expect(reader.jobInterviewPlanInfo.mock.calls.map((c) => c[0])).toEqual(['job-a']);
  });

  it('stops at the deadline: later jobs are not tried, and each call carries the deadline', async () => {
    let clock = 1_000_000;
    const reader = fakeReader();
    reader.jobInterviewPlanInfo.mockImplementation(async () => {
      clock += 15_000;
      return { results: planPayload() as never };
    });
    const { store } = memoryStore(TARGETS);
    const result = await runStageCatalogRefresh(reader, store, { now: () => clock, actorId: ADMIN });
    expect(result.jobs).toEqual({ attempted: 2, read: 2, failed: 0, notTried: 1 });
    expect(result.deadlineHit).toBe(true);
    const options = reader.jobInterviewPlanInfo.mock.calls[0] as unknown as [string, unknown, { deadlineAt: number; failFastPastDeadline: boolean }];
    expect(options[2]).toEqual({ deadlineAt: 1_000_000 + 20_000, failFastPastDeadline: true });
  });

  it('a stage two plans name is written once, with the first plan read', async () => {
    const reader = fakeReader((jobId) => (jobId === 'job-b'
      ? { interviewPlanId: 'plan-b', stages: [{ id: 'stage-09-r1', title: 'R1', type: 'Active', orderInInterviewPlan: 2 }] }
      : planPayload()));
    const { store, writes } = memoryStore(TARGETS);
    const result = await runStageCatalogRefresh(reader, store, { actorId: ADMIN });
    expect(writes[0].filter((s) => s.stageId === 'stage-09-r1')).toHaveLength(1);
    expect(writes[0].find((s) => s.stageId === 'stage-09-r1')?.interviewPlanId).toBe(PLAN);
    expect(result.stages.seen).toBe(18);
  });
});

// ── HELLO's side: the service-role store ────────────────────────────────────

type Ops = Array<[string, unknown[]]>;

/**
 * A recording stand-in for the Supabase client: each query's chained calls are
 * kept, and `answer` decides the result from the table and those calls. Reads
 * and `rpc` only: the store has no other way to write.
 */
function fakeDb(answer: (table: string, ops: Ops) => { data: unknown; error: unknown }) {
  const calls: Array<{ table: string; ops: Ops }> = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let rpcAnswer: { data: unknown; error: unknown } = { data: { status: 'ok' }, error: null };
  const client = {
    from(table: string) {
      const entry = { table, ops: [] as Ops };
      calls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle']) {
        builder[m] = (...args: unknown[]) => { entry.ops.push([m, args]); return builder; };
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(answer(table, entry.ops)).then(resolve, reject);
      return builder;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return Promise.resolve(rpcAnswer);
    },
  };
  return { client, calls, rpcs, answerRpc: (a: { data: unknown; error: unknown }) => { rpcAnswer = a; } };
}

const has = (ops: Ops, method: string, ...args: unknown[]) => ops.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));

describe('createStageCatalogStore', () => {
  it("reads the jobs from enabled mappings, and the Christy stages from every mapping not archived, paused included (S2-2)", async () => {
    const db = fakeDb((table, ops) => {
      expect(table).toBe('ashby_job_mappings');
      if (has(ops, 'eq', 'status', 'enabled')) {
        return { data: [{ external_job_id: 'job-a', ai_screening_stage_id: CHRISTY }], error: null };
      }
      // The live read: enabled and paused mappings alike, never an archived one.
      return { data: [{ ai_screening_stage_id: CHRISTY }, { ai_screening_stage_id: 'stage-06-ta' }, { ai_screening_stage_id: null }, { ai_screening_stage_id: 'has space' }], error: null };
    });
    const targets = await createStageCatalogStore(db.client as never).readTargets();
    expect(targets).toEqual({ enabledMappings: 1, jobIds: ['job-a'], christyStageIds: [CHRISTY, 'stage-06-ta'], truncated: false });
    const live = db.calls.find((c) => !has(c.ops, 'eq', 'status', 'enabled'))!;
    expect(has(live.ops, 'eq', 'provider', 'ashby')).toBe(true);
    expect(has(live.ops, 'is', 'archived_at', null)).toBe(true);
    expect(live.ops.some(([m]) => m === 'limit')).toBe(true);
  });

  it('refuses to guess the Christy stages when there are more live mappings than it reads', async () => {
    const db = fakeDb((_table, ops) => (has(ops, 'eq', 'status', 'enabled')
      ? { data: [], error: null }
      : { data: Array.from({ length: 1001 }, () => ({ ai_screening_stage_id: CHRISTY })), error: null }));
    await expect(createStageCatalogStore(db.client as never).readTargets()).rejects.toThrow(/^ashby_stage_catalog_mappings_/);
  });

  it('a mapping read error throws, with no detail', async () => {
    const db = fakeDb(() => ({ data: null, error: { message: 'secret detail' } }));
    await expect(createStageCatalogStore(db.client as never).readTargets()).rejects.toThrow(/^ashby_stage_catalog_mappings_error$/);
  });

  it('writes through refresh_ashby_stage_catalog and answers its counts, redefaulted included', async () => {
    const db = fakeDb(() => ({ data: [], error: null }));
    db.answerRpc({ data: { status: 'ok', inserted: 1, updated: 17, defaulted: 1, redefaulted: 2, left_plan: 1 }, error: null });
    const store = createStageCatalogStore(db.client as never);
    const counts = await store.writeStages([{ stageId: 's', interviewPlanId: PLAN, title: 'R2', stageType: 'Active', orderInPlan: 9, stageGroupId: null, defaultMilestone: 'r2' }], ADMIN);
    expect(counts).toEqual({ inserted: 1, updated: 17, defaulted: 1, redefaulted: 2, leftPlan: 1 });
    expect(db.rpcs[0].fn).toBe('refresh_ashby_stage_catalog');
    expect(db.rpcs[0].args.p_stages).toEqual([{ stage_id: 's', interview_plan_id: PLAN, title: 'R2', stage_type: 'Active', order_in_plan: 9, stage_group_id: null, default_milestone: 'r2' }]);
    // S2-3: the function audits the write in its own transaction, under this admin.
    expect(db.rpcs[0].args.p_actor_id).toBe(ADMIN);
  });

  it('a refused catalogue write throws, and a database error throws with no detail', async () => {
    const db = fakeDb(() => ({ data: [], error: null }));
    const store = createStageCatalogStore(db.client as never);
    db.answerRpc({ data: { status: 'actor_required' }, error: null });
    await expect(store.writeStages([], ADMIN)).rejects.toThrow(/^ashby_stage_catalog_write_refused$/);
    db.answerRpc({ data: null, error: { message: 'secret detail' } });
    await expect(store.writeStages([], ADMIN)).rejects.toThrow(/^ashby_stage_catalog_write_error$/);
  });

  it('labels a stage through set_ashby_stage_milestone, which writes the label and its audit row together (S2-3)', async () => {
    const db = fakeDb(() => ({ data: [], error: null }));
    db.answerRpc({
      data: {
        status: 'ok',
        milestone_from: 'r1',
        stage: {
          stage_id: 'stage-09-r1', interview_plan_id: PLAN, title: 'R1', stage_type: 'Active', order_in_plan: 8, stage_group_id: null,
          milestone: 'r2', milestone_source: 'admin', source: 'plan', not_in_plan_since: null,
        },
      },
      error: null,
    });
    const store = createStageCatalogStore(db.client as never);
    const result = await store.setMilestone('stage-09-r1', 'r2', 'admin', ADMIN);
    expect(db.rpcs).toEqual([{
      fn: 'set_ashby_stage_milestone',
      args: { p_stage_id: 'stage-09-r1', p_milestone: 'r2', p_milestone_source: 'admin', p_actor_id: ADMIN },
    }]);
    expect(result).toEqual({
      from: 'r1',
      stage: {
        stageId: 'stage-09-r1', interviewPlanId: PLAN, title: 'R1', stageType: 'Active', orderInPlan: 8, stageGroupId: null,
        milestone: 'r2', milestoneSource: 'admin', source: 'plan', inPlan: true,
      },
    });
    // No table write outside the function: the store has no other way to change a label.
    expect(db.calls).toEqual([]);
  });

  it('a cleared label sends no source; an unknown stage is null; a refusal or an error throws with no detail', async () => {
    const db = fakeDb(() => ({ data: [], error: null }));
    const store = createStageCatalogStore(db.client as never);
    db.answerRpc({ data: { status: 'not_found' }, error: null });
    expect(await store.setMilestone('stage-99', null, null, ADMIN)).toBeNull();
    expect(db.rpcs[0].args).toEqual({ p_stage_id: 'stage-99', p_milestone: null, p_milestone_source: null, p_actor_id: ADMIN });
    db.answerRpc({ data: { status: 'invalid_milestone_source' }, error: null });
    await expect(store.setMilestone('stage-09-r1', 'r1', 'admin', ADMIN)).rejects.toThrow(/^ashby_stage_catalog_label_refused$/);
    db.answerRpc({ data: null, error: { message: 'secret detail' } });
    await expect(store.setMilestone('stage-09-r1', 'r1', 'admin', ADMIN)).rejects.toThrow(/^ashby_stage_catalog_label_error$/);
  });

  it('lists the live stages in plan order, then the ones no longer in the plan, each saying which (S2-4)', async () => {
    const row = (id: string, title: string, order: number, gone: string | null) => ({
      stage_id: id, interview_plan_id: PLAN, title, stage_type: 'Active', order_in_plan: order, stage_group_id: null,
      milestone: null, milestone_source: null, source: 'plan', not_in_plan_since: gone,
    });
    const db = fakeDb((table, ops) => {
      if (table === 'ashby_job_mappings') {
        return { data: [{ external_job_id: 'job-a', ai_screening_stage_id: CHRISTY }], error: null };
      }
      if (has(ops, 'in', 'stage_id', [CHRISTY])) return { data: [{ stage_id: CHRISTY, interview_plan_id: PLAN }], error: null };
      expect(ops.some(([m, a]) => m === 'select' && String(a[0]).includes('not_in_plan_since'))).toBe(true);
      return {
        data: [
          row('stage-13-r5', 'R5', 12, '2026-11-10T10:00:00.000Z'),
          row('stage-14-ref', 'Reference Check', 13, null),
          row('stage-13b-panel', 'Panel', 12, null),
          row(CHRISTY, 'Hello Christy', 4, null),
        ],
        error: null,
      };
    });
    const listing = await createStageCatalogStore(db.client as never).listForEnabledPlans();
    expect(listing.stages.map((st) => [st.title, st.inPlan])).toEqual([
      ['Hello Christy', true], ['Panel', true], ['Reference Check', true], ['R5', false],
    ]);
  });
});
