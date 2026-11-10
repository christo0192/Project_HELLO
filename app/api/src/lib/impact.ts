/**
 * lib/impact.ts — the business-impact read model's API side (M031 S5).
 *
 * The numbers are computed in Postgres (migration 0140): `impact_summary` for
 * the page's aggregates and `impact_candidates` for the applications behind one
 * figure, both over `impact_application_rows`, so a list can never disagree with
 * the figure it sits behind. This module only calls them and SHAPES what they
 * answer into `.gsd/milestones/M031/API-CONTRACT.md` exactly: every object is
 * rebuilt key by key from the contract's own field list, so a column the
 * database adds later can never reach a browser, and anything malformed is
 * refused (`ImpactShapeError`, a 503) rather than drawn as a wrong number.
 *
 * Personal data: the summary is counts, shares, days, opaque ids and stage
 * titles. A candidate row carries the candidate record's name and role and
 * nothing else personal: no email, phone, Ashby id or archive free text
 * (D-M031-3). Which rows a viewer gets is the candidate page's rule
 * (lib/candidate-scope.ts, D-M031-5), applied in the database.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CandidateScope } from './candidate-scope.js';

// ── Vocabulary (the contract's keys) ─────────────────────────────────────

export const IMPACT_STEPS = [
  'came_in', 'called', 'connected', 'scored', 'decided', 'moved_forward', 'r1', 'r2', 'offer', 'hired',
] as const;
export type ImpactStep = (typeof IMPACT_STEPS)[number];

export const IMPACT_VERDICTS = ['select', 'borderline', 'reject', 'held', 'none'] as const;
export type ImpactVerdict = (typeof IMPACT_VERDICTS)[number];

export const IMPACT_OUTCOMES = [
  'still_christy', 'archived_christy', 'moved_forward', 'r1', 'r2', 'offer', 'hired', 'active',
] as const;
export type ImpactOutcome = (typeof IMPACT_OUTCOMES)[number];

export const IMPACT_REASON_TYPES = ['rejected_by_org', 'rejected_by_candidate', 'other', 'none'] as const;
export const IMPACT_TIMINGS = [
  'entry_to_first_call', 'entry_to_verdict', 'verdict_to_decision', 'christy_to_r1', 'r1_to_r2', 'r2_to_offer',
  'offer_to_hired',
] as const;
export const IMPACT_SHARE_KEYS = ['connected', 'scored', 'moved_forward', 'r1', 'r2', 'offer', 'hired'] as const;

/** Medians and p90s below this n are withheld (the contract's `meta.minTimingN`). */
export const IMPACT_MIN_TIMING_N = 5;
export const IMPACT_MAX_PAGE_SIZE = 100;
export const IMPACT_DEFAULT_PAGE_SIZE = 50;

/** ASHBY_PROGRESS_ENABLED, read the way every Ashby flag is: exactly `true` turns it on. */
export function impactProgressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ASHBY_PROGRESS_ENABLED === 'true';
}

// ── The store: one call per database function ────────────────────────────

export interface ImpactWindowInput {
  from: string | null;
  to: string | null;
  job: string | null;
}

export type ImpactListTarget =
  | { kind: 'step'; step: ImpactStep; dropped: boolean }
  | { kind: 'verdict'; verdict: ImpactVerdict; outcome: ImpactOutcome }
  | { kind: 'leave'; stageId: string };

export interface ImpactCandidatesInput extends ImpactWindowInput {
  target: ImpactListTarget;
  scope: CandidateScope;
  page: number;
  pageSize: number;
}

/** What a database function answered: `status` plus, on `ok`, its payload. */
export type ImpactRpcAnswer = Record<string, unknown> & { status?: unknown };

export interface ImpactStore {
  summary(input: ImpactWindowInput, progressEnabled: boolean, now: Date): Promise<ImpactRpcAnswer>;
  candidates(input: ImpactCandidatesInput, progressEnabled: boolean, now: Date): Promise<ImpactRpcAnswer>;
  mappingSettings(): Promise<ImpactRpcAnswer>;
  setExclusion(mappingId: string, excluded: boolean | null, actorId: string): Promise<ImpactRpcAnswer>;
}

export class ImpactRpcError extends Error {
  constructor(fn: string) {
    super(`${fn}_rpc_error`);
    this.name = 'ImpactRpcError';
  }
}

function asAnswer(fn: string, data: unknown): ImpactRpcAnswer {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ImpactRpcError(fn);
  return data as ImpactRpcAnswer;
}

export function createSupabaseImpactStore(client: SupabaseClient): ImpactStore {
  const call = async (fn: string, args: Record<string, unknown>): Promise<ImpactRpcAnswer> => {
    const { data, error } = await client.rpc(fn, args);
    // Never echo the driver's message: it can name tables and values.
    if (error) throw new ImpactRpcError(fn);
    return asAnswer(fn, data);
  };
  return {
    summary: (input, progressEnabled, now) => call('impact_summary', {
      p_from: input.from,
      p_to: input.to,
      p_job: input.job,
      p_progress_enabled: progressEnabled,
      p_now: now.toISOString(),
    }),
    candidates: (input, progressEnabled, now) => call('impact_candidates', {
      p_from: input.from,
      p_to: input.to,
      p_job: input.job,
      p_step: input.target.kind === 'step' ? input.target.step : null,
      p_verdict: input.target.kind === 'verdict' ? input.target.verdict : null,
      p_outcome: input.target.kind === 'verdict' ? input.target.outcome : null,
      p_leave_stage_id: input.target.kind === 'leave' ? input.target.stageId : null,
      p_dropped: input.target.kind === 'step' ? input.target.dropped : null,
      p_scope: input.scope.kind,
      p_owner_id: input.scope.kind === 'owner' ? input.scope.ownerId : null,
      p_page: input.page,
      p_page_size: input.pageSize,
      p_progress_enabled: progressEnabled,
      p_now: now.toISOString(),
    }),
    mappingSettings: () => call('ashby_impact_mapping_settings', {}),
    setExclusion: (mappingId, excluded, actorId) => call('set_ashby_impact_exclusion', {
      p_job_mapping_id: mappingId,
      p_excluded: excluded,
      p_actor_id: actorId,
    }),
  };
}

// ── Shaping: the contract, key by key ────────────────────────────────────

/** The database answered something the contract cannot carry: never drawn. */
export class ImpactShapeError extends Error {
  constructor(where: string) {
    super(`impact_malformed:${where}`);
    this.name = 'ImpactShapeError';
  }
}

type Json = Record<string, unknown>;

function obj(v: unknown, where: string): Json {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ImpactShapeError(where);
  return v as Json;
}
function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new ImpactShapeError(where);
  return v;
}
function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new ImpactShapeError(where);
  return v;
}
function strOrNull(v: unknown, where: string): string | null {
  return v === null || v === undefined ? null : str(v, where);
}
function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new ImpactShapeError(where);
  return v;
}
function count(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ImpactShapeError(where);
  return v;
}
function countOrNull(v: unknown, where: string): number | null {
  return v === null || v === undefined ? null : count(v, where);
}
function num(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ImpactShapeError(where);
  return v;
}
function numOrNull(v: unknown, where: string): number | null {
  return v === null || v === undefined ? null : num(v, where);
}
/** A share is a fraction 0..1. Anything above 1 is a nesting bug: refused, never shown. */
function share(v: unknown, where: string): number | null {
  const n = numOrNull(v, where);
  if (n !== null && (n < 0 || n > 1)) throw new ImpactShapeError(where);
  return n;
}
/** Postgres sends `2026-11-09T14:00:00+00:00`; the contract speaks `...000Z`. */
function iso(v: unknown, where: string): string {
  const t = Date.parse(str(v, where));
  if (!Number.isFinite(t)) throw new ImpactShapeError(where);
  return new Date(t).toISOString();
}
function isoOrNull(v: unknown, where: string): string | null {
  return v === null || v === undefined ? null : iso(v, where);
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new ImpactShapeError(where);
  return v as T;
}
function day(v: unknown, where: string): string {
  const s = str(v, where);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ImpactShapeError(where);
  return s;
}
function shares(v: unknown, where: string): Record<string, number | null> {
  const o = obj(v, where);
  const out: Record<string, number | null> = {};
  for (const k of IMPACT_SHARE_KEYS) out[k] = share(o[k], `${where}.${k}`);
  return out;
}

export interface ImpactPipelineStep {
  step: ImpactStep;
  label: string;
  reached: number | null;
  ofPrevious: number | null;
  ofCameIn: number | null;
  stillHere: number | null;
  droppedHere: number | null;
  sub?: { label: string; reached: number | null };
}

export interface ImpactSummaryBody {
  meta: {
    generatedAt: string;
    timezone: string;
    progressEnabled: boolean;
    lastPassAt: string | null;
    coverage: { checked: number; total: number };
    staleRows: number;
    labelsConfigured: boolean;
    unlabelledStages: number;
    minTimingN: number;
  };
  filters: { from: string; to: string; job: string | null; jobs: Array<{ id: string; label: string }> };
  pipeline: ImpactPipelineStep[];
  verdictOutcomes: {
    columns: Array<{ key: ImpactOutcome; label: string }>;
    rows: Array<{ verdict: ImpactVerdict; label: string; total: number; cells: Record<string, number | null> }>;
  };
  leaves: Array<{
    stageId: string;
    stageTitle: string;
    milestone: string | null;
    archived: number;
    byReasonType: Record<string, number>;
    topReasons: Array<{ text: string; count: number }>;
  }>;
  timings: Array<{ key: string; label: string; medianDays: number | null; p90Days: number | null; n: number }>;
  cohorts: Array<{ weekStart: string; ageDays: number; maturing: boolean; cameIn: number; shares: Record<string, number | null> }>;
  byJob: Array<{ jobId: string; label: string; cameIn: number; shares: Record<string, number | null> }>;
}

/** The `summary` impact_summary answered, as the contract's body (without `ok`). */
export function shapeImpactSummary(raw: unknown): ImpactSummaryBody {
  const s = obj(raw, 'summary');
  const m = obj(s.meta, 'meta');
  const cov = obj(m.coverage, 'meta.coverage');
  const f = obj(s.filters, 'filters');

  const pipelineRaw = arr(s.pipeline, 'pipeline');
  if (pipelineRaw.length !== IMPACT_STEPS.length) throw new ImpactShapeError('pipeline.length');
  const pipeline = pipelineRaw.map((p, i): ImpactPipelineStep => {
    const o = obj(p, `pipeline[${i}]`);
    const step = oneOf(o.step, IMPACT_STEPS, `pipeline[${i}].step`);
    if (step !== IMPACT_STEPS[i]) throw new ImpactShapeError(`pipeline[${i}].order`);
    const out: ImpactPipelineStep = {
      step,
      label: str(o.label, `pipeline[${i}].label`),
      reached: countOrNull(o.reached, `pipeline[${i}].reached`),
      ofPrevious: share(o.ofPrevious, `pipeline[${i}].ofPrevious`),
      ofCameIn: share(o.ofCameIn, `pipeline[${i}].ofCameIn`),
      stillHere: countOrNull(o.stillHere, `pipeline[${i}].stillHere`),
      droppedHere: countOrNull(o.droppedHere, `pipeline[${i}].droppedHere`),
    };
    if (step === 'connected') {
      const sub = obj(o.sub, 'pipeline.connected.sub');
      out.sub = { label: str(sub.label, 'sub.label'), reached: countOrNull(sub.reached, 'sub.reached') };
    }
    return out;
  });
  // Steps nest: a known step never counts more than the known step before it.
  for (let i = 1; i < pipeline.length; i++) {
    const here = pipeline[i].reached;
    const before = pipeline[i - 1].reached;
    if (here !== null && before !== null && here > before) throw new ImpactShapeError(`pipeline[${i}].nesting`);
  }

  const vo = obj(s.verdictOutcomes, 'verdictOutcomes');
  const columns = arr(vo.columns, 'verdictOutcomes.columns').map((c, i) => {
    const o = obj(c, `columns[${i}]`);
    return { key: oneOf(o.key, IMPACT_OUTCOMES, `columns[${i}].key`), label: str(o.label, `columns[${i}].label`) };
  });
  const rows = arr(vo.rows, 'verdictOutcomes.rows').map((r, i) => {
    const o = obj(r, `rows[${i}]`);
    const cellsRaw = obj(o.cells, `rows[${i}].cells`);
    const cells: Record<string, number | null> = {};
    for (const k of IMPACT_OUTCOMES) cells[k] = countOrNull(cellsRaw[k], `rows[${i}].cells.${k}`);
    return {
      verdict: oneOf(o.verdict, IMPACT_VERDICTS, `rows[${i}].verdict`),
      label: str(o.label, `rows[${i}].label`),
      total: count(o.total, `rows[${i}].total`),
      cells,
    };
  });

  const leaves = arr(s.leaves, 'leaves').map((l, i) => {
    const o = obj(l, `leaves[${i}]`);
    const br = obj(o.byReasonType, `leaves[${i}].byReasonType`);
    const byReasonType: Record<string, number> = {};
    for (const k of IMPACT_REASON_TYPES) byReasonType[k] = count(br[k], `leaves[${i}].byReasonType.${k}`);
    const top = arr(o.topReasons, `leaves[${i}].topReasons`);
    if (top.length > 5) throw new ImpactShapeError(`leaves[${i}].topReasons.length`);
    return {
      stageId: str(o.stageId, `leaves[${i}].stageId`),
      stageTitle: str(o.stageTitle, `leaves[${i}].stageTitle`),
      milestone: strOrNull(o.milestone, `leaves[${i}].milestone`),
      archived: count(o.archived, `leaves[${i}].archived`),
      byReasonType,
      topReasons: top.map((t, j) => {
        const to = obj(t, `leaves[${i}].topReasons[${j}]`);
        return { text: str(to.text, 'topReasons.text'), count: count(to.count, 'topReasons.count') };
      }),
    };
  });

  const timings = arr(s.timings, 'timings').map((t, i) => {
    const o = obj(t, `timings[${i}]`);
    const n = count(o.n, `timings[${i}].n`);
    const median = numOrNull(o.medianDays, `timings[${i}].medianDays`);
    const p90 = numOrNull(o.p90Days, `timings[${i}].p90Days`);
    // The small-number rule, enforced here as well: under n 5 no time leaves the API.
    const shown = n >= IMPACT_MIN_TIMING_N;
    return {
      key: oneOf(o.key, IMPACT_TIMINGS, `timings[${i}].key`),
      label: str(o.label, `timings[${i}].label`),
      medianDays: shown ? median : null,
      p90Days: shown ? p90 : null,
      n,
    };
  });

  const cohorts = arr(s.cohorts, 'cohorts').map((c, i) => {
    const o = obj(c, `cohorts[${i}]`);
    return {
      weekStart: day(o.weekStart, `cohorts[${i}].weekStart`),
      ageDays: count(o.ageDays, `cohorts[${i}].ageDays`),
      maturing: bool(o.maturing, `cohorts[${i}].maturing`),
      cameIn: count(o.cameIn, `cohorts[${i}].cameIn`),
      shares: shares(o.shares, `cohorts[${i}].shares`),
    };
  });

  const byJob = arr(s.byJob, 'byJob').map((j, i) => {
    const o = obj(j, `byJob[${i}]`);
    return {
      jobId: str(o.jobId, `byJob[${i}].jobId`),
      label: str(o.label, `byJob[${i}].label`),
      cameIn: count(o.cameIn, `byJob[${i}].cameIn`),
      shares: shares(o.shares, `byJob[${i}].shares`),
    };
  });

  return {
    meta: {
      generatedAt: iso(m.generatedAt, 'meta.generatedAt'),
      timezone: str(m.timezone, 'meta.timezone'),
      progressEnabled: bool(m.progressEnabled, 'meta.progressEnabled'),
      lastPassAt: isoOrNull(m.lastPassAt, 'meta.lastPassAt'),
      coverage: { checked: count(cov.checked, 'coverage.checked'), total: count(cov.total, 'coverage.total') },
      staleRows: count(m.staleRows, 'meta.staleRows'),
      labelsConfigured: bool(m.labelsConfigured, 'meta.labelsConfigured'),
      unlabelledStages: count(m.unlabelledStages, 'meta.unlabelledStages'),
      minTimingN: count(m.minTimingN, 'meta.minTimingN'),
    },
    filters: {
      from: day(f.from, 'filters.from'),
      to: day(f.to, 'filters.to'),
      job: strOrNull(f.job, 'filters.job'),
      jobs: arr(f.jobs, 'filters.jobs').map((j, i) => {
        const o = obj(j, `filters.jobs[${i}]`);
        return { id: str(o.id, `filters.jobs[${i}].id`), label: str(o.label, `filters.jobs[${i}].label`) };
      }),
    },
    pipeline,
    verdictOutcomes: { columns, rows },
    leaves,
    timings,
    cohorts,
    byJob,
  };
}

export interface ImpactCandidateRow {
  candidateId: string | null;
  name: string | null;
  roleTitle: string | null;
  verdict: ImpactVerdict | null;
  score: number | null;
  provisional: boolean;
  currentStageTitle: string | null;
  currentMilestone: string | null;
  status: string | null;
  enteredChristyAt: string | null;
  lastMoveAt: string | null;
}

export interface ImpactCandidatesBody {
  total: number;
  hidden: number;
  page: number;
  pageSize: number;
  rows: ImpactCandidateRow[];
}

/**
 * One page impact_candidates answered, as the contract's body (without `ok`).
 * A row is rebuilt from the contract's eleven fields only. A row with no
 * candidate record is allowed only for a viewer who can open every candidate
 * (`scopeAll`); for anyone else it would be a leak, so the page is refused.
 */
export function shapeImpactCandidates(raw: unknown, scopeAll: boolean): ImpactCandidatesBody {
  const o = obj(raw, 'candidates');
  const pageSize = count(o.pageSize, 'pageSize');
  const rows = arr(o.rows, 'rows').map((r, i): ImpactCandidateRow => {
    const x = obj(r, `rows[${i}]`);
    const candidateId = strOrNull(x.candidateId, `rows[${i}].candidateId`);
    if (candidateId === null && !scopeAll) throw new ImpactShapeError(`rows[${i}].scope`);
    return {
      candidateId,
      name: strOrNull(x.name, `rows[${i}].name`),
      roleTitle: strOrNull(x.roleTitle, `rows[${i}].roleTitle`),
      verdict: x.verdict === null || x.verdict === undefined ? null : oneOf(x.verdict, IMPACT_VERDICTS, `rows[${i}].verdict`),
      score: numOrNull(x.score, `rows[${i}].score`),
      provisional: bool(x.provisional, `rows[${i}].provisional`),
      currentStageTitle: strOrNull(x.currentStageTitle, `rows[${i}].currentStageTitle`),
      currentMilestone: strOrNull(x.currentMilestone, `rows[${i}].currentMilestone`),
      status: strOrNull(x.status, `rows[${i}].status`),
      enteredChristyAt: isoOrNull(x.enteredChristyAt, `rows[${i}].enteredChristyAt`),
      lastMoveAt: isoOrNull(x.lastMoveAt, `rows[${i}].lastMoveAt`),
    };
  });
  if (rows.length > pageSize || pageSize > IMPACT_MAX_PAGE_SIZE) throw new ImpactShapeError('rows.length');
  return {
    total: count(o.total, 'total'),
    hidden: count(o.hidden, 'hidden'),
    page: count(o.page, 'page'),
    pageSize,
    rows,
  };
}

export interface ImpactMappingSetting {
  id: string;
  roleTitle: string;
  label: string | null;
  archived: boolean;
  excluded: boolean | null;
  inImpact: boolean;
}

export function shapeImpactMappingSettings(raw: unknown): { mappings: ImpactMappingSetting[]; truncated: boolean } {
  const o = obj(raw, 'settings');
  return {
    truncated: bool(o.truncated, 'truncated'),
    mappings: arr(o.mappings, 'mappings').map((m, i) => {
      const x = obj(m, `mappings[${i}]`);
      return {
        id: str(x.id, `mappings[${i}].id`),
        roleTitle: str(x.roleTitle, `mappings[${i}].roleTitle`),
        label: strOrNull(x.label, `mappings[${i}].label`),
        archived: bool(x.archived, `mappings[${i}].archived`),
        excluded: x.excluded === null || x.excluded === undefined ? null : bool(x.excluded, `mappings[${i}].excluded`),
        inImpact: bool(x.inImpact, `mappings[${i}].inImpact`),
      };
    }),
  };
}
