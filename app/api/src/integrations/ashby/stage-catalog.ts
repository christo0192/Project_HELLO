/**
 * ashby/stage-catalog.ts — the Ashby stage catalogue (M031 S2).
 *
 * The business-impact page counts how far an imported application got: R1 or
 * later, Offer or later, Hired. Ashby knows each stage only by an opaque id,
 * a title, a type and a plan position, so HELLO keeps one row per stage in
 * `screening_v2.ashby_stage_catalog` (0138) with the MILESTONE it counts as:
 * christy, r1..r5, reference, offer, hired, archived or other. NULL is "Other,
 * not labelled", and such a stage never disappears from the counts.
 *
 * THE REFRESH reads `jobInterviewPlan.info` for each enabled mapping's job
 * (Jobs read), with the S1 stage parsing (`extractStages`: type, order and
 * group id, each validated), and upserts every stage through ONE function,
 * `refresh_ashby_stage_catalog`. That function never deletes and never touches
 * a label an admin set (decided under the row lock, so a label racing a
 * refresh is never overwritten). Every other label is recomputed on every
 * refresh from the plan as it stands: a stage Ashby renames or retypes, or one
 * a mapping stops naming as its Christy stage, takes its new default or none
 * (`redefaulted`), so a stored `default` is always what the rules say today.
 * A stage a plan read no longer lists is kept, label and all, for the history
 * that points at it, and marked `not_in_plan_since` (`leftPlan`): the list
 * shows it after the live stages as no longer in the Ashby plan.
 *
 * DEFAULTS ({@link defaultMilestone}), first match wins:
 *   1. the Christy stage (`ai_screening_stage_id`) of any mapping not archived,
 *      paused included: the applications it imported entered that stage;
 *   2. Ashby type Offer, Hired or Archived is offer, hired or archived;
 *   3. an Active stage titled exactly R1..R5 (trimmed, any case) is r1..r5;
 *   4. a stage titled exactly "Reference Check" (trimmed, any case) is reference;
 *   5. anything else has none: an admin labels it, or it counts as Other.
 *
 * LABELLING: an admin sets a milestone (source `admin`). Clearing one returns
 * the stage to its default, if it has one (source `default`), computed by the
 * same rules and the same Christy stages as the refresh, so what is stored is
 * what the next refresh would leave; to say a stage is NOT a milestone, label
 * it `other`. Who labelled it is in the audit row: the table
 * stores the kind of setter, never a staff id.
 *
 * AUDITED IN THE WRITE'S OWN TRANSACTION. Both writes are SECURITY DEFINER
 * functions (0138) that take the admin's id and insert their audit_events row
 * in the same transaction as the change: `refresh_ashby_stage_catalog` (counts
 * only) and `set_ashby_stage_milestone` (the label before and after). A change
 * is never saved without its audit row, and an audit row Postgres refuses
 * rolls the change back with it.
 *
 * READ-ONLY toward Ashby by construction: {@link STAGE_CATALOG_READ_OPERATIONS}
 * is the allowlist and {@link assertStageCatalogReadOnly} refuses anything
 * else, or anything the registry marks as a mutation. HELLO-side it writes the
 * catalogue only; links, candidates and assessments are never touched.
 *
 * SANITIZED: opaque ids, bounded titles, identifier-shaped types, plan order
 * and group ids cross this boundary. No hiring team, interviewer, email or
 * any other sibling field of the plan payload is read.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyAccessError, type AccessErrorCode } from './access-check.js';
import { extractInterviewPlanId, extractStages } from './probe.js';
import { ASHBY_OPERATIONS, type AshbyCallOptions, type AshbyOperation, type OpaqueRecord } from './types.js';

// ── Read-only allowlist ─────────────────────────────────────────────────────

/** The ONLY Ashby operation the catalogue may perform. `mutation: false`. */
export const STAGE_CATALOG_READ_OPERATIONS = ['jobInterviewPlan.info'] as const;
export type StageCatalogOperation = (typeof STAGE_CATALOG_READ_OPERATIONS)[number];

/** Fail closed unless the operation is an allowlisted READ in the registry. */
export function assertStageCatalogReadOnly(operation: string): asserts operation is StageCatalogOperation {
  if (!(STAGE_CATALOG_READ_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error('ashby_stage_catalog_operation_not_allowed');
  }
  const spec = ASHBY_OPERATIONS[operation as AshbyOperation];
  if (!spec || spec.mutation) throw new Error('ashby_stage_catalog_operation_not_allowed');
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * What a stage can count as, in the order the picker offers them. The 0138
 * CHECK `chk_ashby_stage_catalog_milestone` is exactly this list (a test pins
 * the two together).
 */
export const STAGE_MILESTONES = [
  'christy', 'r1', 'r2', 'r3', 'r4', 'r5', 'reference', 'offer', 'hired', 'archived', 'other',
] as const;
export type StageMilestone = (typeof STAGE_MILESTONES)[number];

/** Who set a label, as a kind. Never a person. */
export const MILESTONE_SOURCES = ['admin', 'default'] as const;
export type MilestoneSource = (typeof MILESTONE_SOURCES)[number];

export function isStageMilestone(raw: unknown): raw is StageMilestone {
  return typeof raw === 'string' && (STAGE_MILESTONES as readonly string[]).includes(raw);
}

function isMilestoneSource(raw: unknown): raw is MilestoneSource {
  return typeof raw === 'string' && (MILESTONE_SOURCES as readonly string[]).includes(raw);
}

// ── Default milestones ──────────────────────────────────────────────────────

const ROUND_TITLE_RE = /^r([1-5])$/i;
const REFERENCE_TITLE = 'reference check';
const TYPE_DEFAULTS: Readonly<Record<string, StageMilestone>> = {
  Offer: 'offer',
  Hired: 'hired',
  Archived: 'archived',
};

/**
 * The milestone a stage gets when nobody has labelled it, or null. Pure: the
 * caller passes the Christy stage ids of the enabled mappings.
 */
export function defaultMilestone(
  stage: { id: string; type: string | null; title: string | null },
  christyStageIds: ReadonlySet<string>,
): StageMilestone | null {
  if (christyStageIds.has(stage.id)) return 'christy';
  const byType = stage.type !== null && Object.prototype.hasOwnProperty.call(TYPE_DEFAULTS, stage.type)
    ? TYPE_DEFAULTS[stage.type]
    : null;
  if (byType) return byType;
  const title = typeof stage.title === 'string' ? stage.title.trim() : '';
  if (stage.type === 'Active') {
    const round = ROUND_TITLE_RE.exec(title);
    if (round) return `r${round[1]}` as StageMilestone;
  }
  if (title.toLowerCase() === REFERENCE_TITLE) return 'reference';
  return null;
}

// ── Reading a plan ──────────────────────────────────────────────────────────

/** One stage as a plan read gives it. Every field but the id may be null. */
export interface CatalogPlanStage {
  stageId: string;
  interviewPlanId: string | null;
  title: string | null;
  stageType: string | null;
  orderInPlan: number | null;
  stageGroupId: string | null;
}

/**
 * The stages of one `jobInterviewPlan.info` payload, in plan order, through
 * the S1 parser (`extractStages`), plus the plan id the payload names.
 */
export function readPlanStages(results: unknown): CatalogPlanStage[] {
  const planId = extractInterviewPlanId(results);
  return extractStages(results).map((s) => ({
    stageId: s.id,
    interviewPlanId: planId,
    title: s.title,
    stageType: s.type,
    // The column is a Postgres integer: a position past it is unusable, not a reason to fail the write.
    orderInPlan: s.orderInInterviewPlan !== null && s.orderInInterviewPlan <= PG_INTEGER_MAX ? s.orderInInterviewPlan : null,
    stageGroupId: s.interviewStageGroupId,
  }));
}

const PG_INTEGER_MAX = 2_147_483_647;

// ── Seams ───────────────────────────────────────────────────────────────────

/** The one read the refresh makes. Satisfied by AshbyClient; injected for tests. */
export interface StageCatalogReader {
  jobInterviewPlanInfo<T = OpaqueRecord>(jobId: string, extra?: OpaqueRecord, options?: AshbyCallOptions): Promise<{ results: T }>;
}

/** What the refresh needs from HELLO's mappings. Opaque ids only, never returned. */
export interface StageCatalogTargets {
  /** Enabled, live mappings read (bounded). */
  enabledMappings: number;
  /** Distinct Ashby job ids of those mappings, newest mapping first. */
  jobIds: string[];
  /**
   * Distinct Christy stage ids (`ai_screening_stage_id`) of EVERY mapping not
   * archived: enabled, paused or drifted. A paused mapping's imports entered
   * its Christy stage, so the stage keeps counting as christy.
   */
  christyStageIds: string[];
  /** True when there were more enabled mappings than were read. */
  truncated: boolean;
}

/** What one catalogue write did. inserted + updated = stages written. */
export interface StageCatalogWriteCounts {
  inserted: number;
  updated: number;
  /** Stages that had no label and now carry a default one. */
  defaulted: number;
  /** Stages whose default label moved (renamed, retyped, Christy stage moved), to another or to none. */
  redefaulted: number;
  /** Stages of a plan read this time that it no longer lists: kept, and newly marked as not in the plan. */
  leftPlan: number;
}

/** One stage for refresh_ashby_stage_catalog, with the default it would get. */
export interface StageCatalogUpsert extends CatalogPlanStage {
  defaultMilestone: StageMilestone | null;
}

/** One catalogue row as stored. */
export interface StoredStage extends CatalogPlanStage {
  milestone: StageMilestone | null;
  milestoneSource: MilestoneSource | null;
  source: 'plan' | 'history';
  /** False once a read of its plan stopped listing it (`not_in_plan_since` set). */
  inPlan: boolean;
}

export interface StageCatalogListing {
  /** Enabled, live mappings read. */
  enabledMappings: number;
  /** Enabled mappings whose plan is not in the catalogue yet (never refreshed). */
  unreadMappings: number;
  /** True when a bound cut the mappings or the stages. */
  truncated: boolean;
  /** The stages of the enabled mappings' plans: the live ones in plan order, then those no longer in it. */
  stages: StoredStage[];
}

export interface StageCatalogStore {
  readTargets(): Promise<StageCatalogTargets>;
  /**
   * refresh_ashby_stage_catalog: insert or refresh, recompute every label but
   * an admin's, mark stages that left a plan read, never delete. The function
   * writes its audit row, under `actorId`, in the same transaction.
   */
  writeStages(stages: StageCatalogUpsert[], actorId: string): Promise<StageCatalogWriteCounts>;
  listForEnabledPlans(): Promise<StageCatalogListing>;
  readStage(stageId: string): Promise<StoredStage | null>;
  /**
   * set_ashby_stage_milestone: the label and its audit row (under `actorId`)
   * in one transaction. Answers the label it replaced, read under the row
   * lock, and the row as now stored; null when no such stage.
   */
  setMilestone(
    stageId: string,
    milestone: StageMilestone | null,
    source: MilestoneSource | null,
    actorId: string,
  ): Promise<{ from: StageMilestone | null; stage: StoredStage } | null>;
}

// ── Bounds ──────────────────────────────────────────────────────────────────

/** Distinct jobs one refresh reads. Every mapped job shares one plan today. */
export const MAX_REFRESH_JOBS = 5;
/** Budget for the WHOLE refresh, every call and retry included. */
export const REFRESH_DEADLINE_MS = 20_000;
/** Enabled mappings read; one more says there were more. */
export const MAPPING_READ_CAP = 50;
/**
 * Mappings not archived read for their Christy stage. Past it the refresh and
 * a cleared label refuse to guess: a Christy stage left unread would lose its
 * christy default.
 */
export const LIVE_MAPPING_READ_CAP = 1_000;
/** Catalogue rows one listing returns; one more says there were more. */
export const LISTING_ROW_CAP = 500;

const ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

function opaqueId(raw: unknown): string | null {
  return typeof raw === 'string' && ID_RE.test(raw) ? raw : null;
}

// ── The refresh ─────────────────────────────────────────────────────────────

/** `missing_permission` or one of the access check's coarse codes. */
export type RefreshFailureCode = 'missing_permission' | AccessErrorCode;

export interface StageCatalogRefreshResult {
  mappings: { enabled: number; truncated: boolean };
  /** attempted = read + failed; notTried = the deadline left no time. */
  jobs: { attempted: number; read: number; failed: number; notTried: number };
  /** Failed job reads by code, in order of first occurrence. */
  failures: Array<{ code: RefreshFailureCode; count: number }>;
  /** seen = distinct stages read; the rest are the store's counts. */
  stages: { seen: number } & StageCatalogWriteCounts;
  deadlineHit: boolean;
}

export interface RunStageCatalogRefreshOptions {
  /** Wall clock (epoch ms). A real Ashby client compares deadlines against Date.now(). */
  now?: () => number;
  /** The admin whose request runs the refresh: the catalogue write is audited under this id. */
  actorId: string;
}

/**
 * Read every enabled job's plan and upsert its stages. Never throws for a
 * provider failure: each is counted by code. Throws only when HELLO's own
 * tables cannot be read or written. Never deletes.
 */
export async function runStageCatalogRefresh(
  reader: StageCatalogReader,
  store: StageCatalogStore,
  options: RunStageCatalogRefreshOptions,
): Promise<StageCatalogRefreshResult> {
  const now = options.now ?? Date.now;
  const deadlineAt = now() + REFRESH_DEADLINE_MS;
  const targets = await store.readTargets();

  const distinctJobs = [...new Set(targets.jobIds.map(opaqueId).filter((id): id is string => id !== null))];
  const jobs = distinctJobs.slice(0, MAX_REFRESH_JOBS);
  const christy = new Set(targets.christyStageIds.map(opaqueId).filter((id): id is string => id !== null));

  const failures = new Map<RefreshFailureCode, number>();
  let read = 0;
  let failed = 0;
  let notTried = 0;
  let deadlineHit = false;
  // First plan read wins for a stage two plans name (a stage belongs to one plan).
  const byId = new Map<string, StageCatalogUpsert>();

  assertStageCatalogReadOnly('jobInterviewPlan.info');
  for (const jobId of jobs) {
    if (now() >= deadlineAt) {
      deadlineHit = true;
      notTried += 1;
      continue;
    }
    try {
      const res = await reader.jobInterviewPlanInfo(jobId, undefined, { deadlineAt, failFastPastDeadline: true });
      read += 1;
      for (const stage of readPlanStages(res.results)) {
        if (byId.has(stage.stageId)) continue;
        byId.set(stage.stageId, {
          ...stage,
          defaultMilestone: defaultMilestone({ id: stage.stageId, type: stage.stageType, title: stage.title }, christy),
        });
      }
    } catch (err) {
      failed += 1;
      const verdict = classifyAccessError(err);
      const code: RefreshFailureCode = verdict.state === 'missing_permission' ? 'missing_permission' : verdict.error;
      failures.set(code, (failures.get(code) ?? 0) + 1);
      if (now() >= deadlineAt) deadlineHit = true;
    }
  }

  const stages = [...byId.values()];
  const written = stages.length > 0
    ? await store.writeStages(stages, options.actorId)
    : { inserted: 0, updated: 0, defaulted: 0, redefaulted: 0, leftPlan: 0 };

  return {
    mappings: {
      enabled: Math.max(0, Math.trunc(targets.enabledMappings) || 0),
      truncated: targets.truncated === true || distinctJobs.length > MAX_REFRESH_JOBS,
    },
    jobs: { attempted: read + failed, read, failed, notTried },
    failures: [...failures.entries()].map(([code, count]) => ({ code, count })),
    stages: { seen: stages.length, ...written },
    deadlineHit,
  };
}

// ── HELLO's side ────────────────────────────────────────────────────────────

const CATALOG_COLUMNS =
  'stage_id, interview_plan_id, title, stage_type, order_in_plan, stage_group_id, milestone, milestone_source, source, not_in_plan_since';

function toStored(raw: Record<string, unknown>): StoredStage | null {
  const stageId = opaqueId(raw.stage_id);
  if (!stageId) return null;
  const order = raw.order_in_plan;
  return {
    stageId,
    interviewPlanId: opaqueId(raw.interview_plan_id),
    title: typeof raw.title === 'string' ? raw.title : null,
    stageType: typeof raw.stage_type === 'string' ? raw.stage_type : null,
    orderInPlan: typeof order === 'number' && Number.isSafeInteger(order) && order >= 0 ? order : null,
    stageGroupId: opaqueId(raw.stage_group_id),
    milestone: isStageMilestone(raw.milestone) ? raw.milestone : null,
    milestoneSource: isMilestoneSource(raw.milestone_source) ? raw.milestone_source : null,
    source: raw.source === 'history' ? 'history' : 'plan',
    inPlan: raw.not_in_plan_since === null || raw.not_in_plan_since === undefined,
  };
}

/**
 * The list's order: the stages in a plan first and those no longer in it last,
 * then plan, then position (unknown last), then title, then id.
 */
export function comparePlanOrder(a: StoredStage, b: StoredStage, planRank: ReadonlyMap<string | null, number>): number {
  if (a.inPlan !== b.inPlan) return a.inPlan ? -1 : 1;
  const pa = planRank.get(a.interviewPlanId) ?? Number.MAX_SAFE_INTEGER;
  const pb = planRank.get(b.interviewPlanId) ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  const oa = a.orderInPlan ?? Number.MAX_SAFE_INTEGER;
  const ob = b.orderInPlan ?? Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  const ta = a.title ?? '';
  const tb = b.title ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.stageId < b.stageId ? -1 : a.stageId > b.stageId ? 1 : 0;
}

/**
 * The service-role store. Reads mappings (job and Christy stage ids), reads the
 * catalogue, and writes it only through refresh_ashby_stage_catalog and
 * set_ashby_stage_milestone, each of which audits its write in the same
 * transaction. Never deletes; never touches a link, a candidate or an
 * assessment.
 */
export function createStageCatalogStore(client: SupabaseClient): StageCatalogStore {
  async function enabledMappings(): Promise<{ rows: Array<{ jobId: string | null; christyId: string | null }>; truncated: boolean }> {
    const { data, error } = await client
      .from('ashby_job_mappings')
      .select('external_job_id, ai_screening_stage_id')
      .eq('provider', 'ashby')
      .eq('status', 'enabled')
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(MAPPING_READ_CAP + 1);
    if (error) throw new Error('ashby_stage_catalog_mappings_error');
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return {
      rows: rows.slice(0, MAPPING_READ_CAP).map((r) => ({ jobId: opaqueId(r.external_job_id), christyId: opaqueId(r.ai_screening_stage_id) })),
      truncated: rows.length > MAPPING_READ_CAP,
    };
  }

  // Every mapping not archived, for its Christy stage: one paused still
  // imported applications into it. Bounded, and refused past the bound rather
  // than silently missing a Christy stage.
  async function liveChristyStageIds(): Promise<string[]> {
    const { data, error } = await client
      .from('ashby_job_mappings')
      .select('ai_screening_stage_id')
      .eq('provider', 'ashby')
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(LIVE_MAPPING_READ_CAP + 1);
    if (error) throw new Error('ashby_stage_catalog_mappings_error');
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    if (rows.length > LIVE_MAPPING_READ_CAP) throw new Error('ashby_stage_catalog_mappings_unbounded');
    return [...new Set(rows.map((r) => opaqueId(r.ai_screening_stage_id)).filter((id): id is string => id !== null))];
  }

  return {
    async readTargets() {
      const { rows, truncated } = await enabledMappings();
      return {
        enabledMappings: rows.length,
        jobIds: [...new Set(rows.map((r) => r.jobId).filter((id): id is string => id !== null))],
        christyStageIds: await liveChristyStageIds(),
        truncated,
      };
    },

    async writeStages(stages, actorId) {
      const payload = stages.map((s) => ({
        stage_id: s.stageId,
        interview_plan_id: s.interviewPlanId,
        title: s.title,
        stage_type: s.stageType,
        order_in_plan: s.orderInPlan,
        stage_group_id: s.stageGroupId,
        default_milestone: s.defaultMilestone,
      }));
      const { data, error } = await client.rpc('refresh_ashby_stage_catalog', { p_stages: payload, p_actor_id: actorId });
      if (error) throw new Error('ashby_stage_catalog_write_error');
      const res = (data ?? {}) as Record<string, unknown>;
      if (res.status !== 'ok') throw new Error('ashby_stage_catalog_write_refused');
      const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
      return {
        inserted: count(res.inserted),
        updated: count(res.updated),
        defaulted: count(res.defaulted),
        redefaulted: count(res.redefaulted),
        leftPlan: count(res.left_plan),
      };
    },

    async listForEnabledPlans() {
      const { rows: mappings, truncated: mappingsCut } = await enabledMappings();
      const christyIds = [...new Set(mappings.map((m) => m.christyId).filter((id): id is string => id !== null))];
      if (christyIds.length === 0) {
        return { enabledMappings: mappings.length, unreadMappings: 0, truncated: mappingsCut, stages: [] };
      }
      // A Christy stage belongs to its job's plan, so it names the plan to list.
      const anchors = await client
        .from('ashby_stage_catalog')
        .select('stage_id, interview_plan_id')
        .in('stage_id', christyIds);
      if (anchors.error) throw new Error('ashby_stage_catalog_read_error');
      const planOf = new Map<string, string | null>();
      for (const r of (anchors.data ?? []) as Array<Record<string, unknown>>) {
        const id = opaqueId(r.stage_id);
        if (id) planOf.set(id, opaqueId(r.interview_plan_id));
      }
      const unreadMappings = mappings.filter((m) => !m.christyId || !planOf.has(m.christyId)).length;
      // Plans in the order of the newest mapping that names them.
      const planRank = new Map<string | null, number>();
      for (const m of mappings) {
        if (!m.christyId || !planOf.has(m.christyId)) continue;
        const plan = planOf.get(m.christyId) ?? null;
        if (!planRank.has(plan)) planRank.set(plan, planRank.size);
      }
      const planIds = [...planRank.keys()].filter((id): id is string => id !== null);
      const stages: StoredStage[] = [];
      let truncated = mappingsCut;
      if (planIds.length > 0) {
        const res = await client
          .from('ashby_stage_catalog')
          .select(CATALOG_COLUMNS)
          .in('interview_plan_id', planIds)
          .limit(LISTING_ROW_CAP + 1);
        if (res.error) throw new Error('ashby_stage_catalog_read_error');
        const rows = (res.data ?? []) as unknown as Array<Record<string, unknown>>;
        truncated ||= rows.length > LISTING_ROW_CAP;
        for (const r of rows.slice(0, LISTING_ROW_CAP)) {
          const s = toStored(r);
          if (s) stages.push(s);
        }
      }
      // A plan read that named no plan id still lists its stages: those the
      // plan read wrote with no plan, beside the Christy stage that has none.
      if (planRank.has(null)) {
        const res = await client
          .from('ashby_stage_catalog')
          .select(CATALOG_COLUMNS)
          .is('interview_plan_id', null)
          .eq('source', 'plan')
          .limit(LISTING_ROW_CAP + 1);
        if (res.error) throw new Error('ashby_stage_catalog_read_error');
        const rows = (res.data ?? []) as unknown as Array<Record<string, unknown>>;
        truncated ||= rows.length > LISTING_ROW_CAP;
        for (const r of rows.slice(0, LISTING_ROW_CAP)) {
          const s = toStored(r);
          if (s) stages.push(s);
        }
      }
      stages.sort((a, b) => comparePlanOrder(a, b, planRank));
      return { enabledMappings: mappings.length, unreadMappings, truncated, stages };
    },

    async readStage(stageId) {
      const { data, error } = await client
        .from('ashby_stage_catalog')
        .select(CATALOG_COLUMNS)
        .eq('stage_id', stageId)
        .maybeSingle();
      if (error) throw new Error('ashby_stage_catalog_read_error');
      return data ? toStored(data as unknown as Record<string, unknown>) : null;
    },

    async setMilestone(stageId, milestone, source, actorId) {
      const { data, error } = await client.rpc('set_ashby_stage_milestone', {
        p_stage_id: stageId,
        p_milestone: milestone,
        p_milestone_source: milestone === null ? null : source,
        p_actor_id: actorId,
      });
      if (error) throw new Error('ashby_stage_catalog_label_error');
      const res = (data ?? {}) as Record<string, unknown>;
      if (res.status === 'not_found') return null;
      if (res.status !== 'ok') throw new Error('ashby_stage_catalog_label_refused');
      const stage = res.stage && typeof res.stage === 'object' ? toStored(res.stage as Record<string, unknown>) : null;
      if (!stage) throw new Error('ashby_stage_catalog_label_refused');
      return { from: isStageMilestone(res.milestone_from) ? res.milestone_from : null, stage };
    },
  };
}
