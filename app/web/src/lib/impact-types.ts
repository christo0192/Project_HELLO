/**
 * The Business impact wire shapes (M031), exactly as
 * `.gsd/milestones/M031/API-CONTRACT.md` fixes them. Types and constant key
 * lists only, with no runtime import, so the offline e2e harness can type its
 * fixture against the same shapes the page reads (as `r1-types.ts` does).
 */

/** The pipeline steps, in order. Each is a subset of the one before. */
export const IMPACT_STEP_KEYS = [
  'came_in',
  'called',
  'connected',
  'scored',
  'decided',
  'moved_forward',
  'r1',
  'r2',
  'offer',
  'hired',
] as const;
export type ImpactStepKey = (typeof IMPACT_STEP_KEYS)[number];

export type ImpactVerdictKey = 'select' | 'borderline' | 'reject' | 'held' | 'none';
export type ImpactOutcomeKey =
  | 'still_christy'
  | 'archived_christy'
  | 'moved_forward'
  | 'r1'
  | 'r2'
  | 'offer'
  | 'hired'
  | 'active';
export type ImpactReasonType = 'rejected_by_org' | 'rejected_by_candidate' | 'other' | 'none';
/** The steps a cohort or a job row gives a share for. */
export const IMPACT_SHARE_KEYS = ['connected', 'scored', 'moved_forward', 'r1', 'r2', 'offer', 'hired'] as const;
export type ImpactShareKey = (typeof IMPACT_SHARE_KEYS)[number];
export type ImpactTimingKey =
  | 'entry_to_first_call'
  | 'entry_to_verdict'
  | 'verdict_to_decision'
  | 'christy_to_r1'
  | 'r1_to_r2'
  | 'r2_to_offer'
  | 'offer_to_hired';
/**
 * The timings Ashby has to supply: each ends at or after a person deciding in
 * Ashby. While Ashby stages are not read they are not known, whatever n says.
 */
export const IMPACT_ASHBY_TIMING_KEYS: readonly ImpactTimingKey[] = [
  'verdict_to_decision',
  'christy_to_r1',
  'r1_to_r2',
  'r2_to_offer',
  'offer_to_hired',
];

export interface ImpactMeta {
  generatedAt: string;
  timezone: string;
  /** False while the Ashby progress worker is off: every Ashby-side figure is null. */
  progressEnabled: boolean;
  lastPassAt: string | null;
  coverage: { checked: number; total: number };
  staleRows: number;
  labelsConfigured: boolean;
  unlabelledStages: number;
  /** Timings below this n come back null (5). */
  minTimingN: number;
}

export interface ImpactJobOption {
  id: string;
  label: string;
}

export interface ImpactFilters {
  from: string;
  to: string;
  job: string | null;
  jobs: ImpactJobOption[];
}

export interface ImpactPipelineStep {
  step: ImpactStepKey;
  label: string;
  /** Null for an Ashby-side step while Ashby stages are not being read. */
  reached: number | null;
  /** A fraction 0..1; null where it does not apply. */
  ofPrevious: number | null;
  ofCameIn: number | null;
  stillHere: number | null;
  droppedHere: number | null;
  /** The connected step's "Call answered" line. */
  sub?: { label: string; reached: number | null };
}

export interface ImpactOutcomeColumn {
  key: ImpactOutcomeKey;
  label: string;
}

export interface ImpactVerdictRow {
  verdict: ImpactVerdictKey;
  label: string;
  total: number;
  /** A missing or null cell is not known, never zero. */
  cells: Partial<Record<ImpactOutcomeKey, number | null>>;
}

export interface ImpactVerdictOutcomes {
  columns: ImpactOutcomeColumn[];
  rows: ImpactVerdictRow[];
}

export interface ImpactLeave {
  stageId: string;
  stageTitle: string;
  milestone: string | null;
  archived: number;
  byReasonType: Partial<Record<ImpactReasonType, number>>;
  /** Ashby's reason catalogue text only, at most five. */
  topReasons: Array<{ text: string; count: number }>;
}

export interface ImpactTiming {
  key: ImpactTimingKey;
  label: string;
  /** Null when n is under `meta.minTimingN`. */
  medianDays: number | null;
  p90Days: number | null;
  n: number;
}

export type ImpactShares = Partial<Record<ImpactShareKey, number | null>>;

export interface ImpactCohort {
  /** The Monday of the IST week, YYYY-MM-DD. */
  weekStart: string;
  ageDays: number;
  maturing: boolean;
  cameIn: number;
  shares: ImpactShares;
}

export interface ImpactJobRow {
  jobId: string;
  label: string;
  cameIn: number;
  shares: ImpactShares;
}

export interface ImpactSummary {
  ok: true;
  meta: ImpactMeta;
  filters: ImpactFilters;
  pipeline: ImpactPipelineStep[];
  verdictOutcomes: ImpactVerdictOutcomes;
  leaves: ImpactLeave[];
  timings: ImpactTiming[];
  cohorts: ImpactCohort[];
  byJob: ImpactJobRow[];
}

export interface ImpactCandidateRow {
  /**
   * Null for an application HELLO imported that never became a candidate, such
   * as a no-resume import still queued (plan section 4, "Stuck imports"). It
   * came in, so it is counted and listed, with no candidate page to open. The
   * contract's example leaves this case out; S5 is to confirm it.
   */
  candidateId: string | null;
  /** From the candidate record, so null when there is none. */
  name: string | null;
  roleTitle: string | null;
  verdict: ImpactVerdictKey | null;
  /** Null when there is none, or when the candidate page would hide it. */
  score: number | null;
  provisional: boolean;
  currentStageTitle: string | null;
  currentMilestone: string | null;
  status: string | null;
  enteredChristyAt: string | null;
  lastMoveAt: string | null;
}

export interface ImpactCandidatesPage {
  ok: true;
  /** The applications listed for this viewer, across every page. Paging counts these only. */
  total: number;
  /**
   * The applications behind the same figure that this viewer cannot open
   * (D-M031-5), so `total + hidden` is the figure on the page. They follow the
   * candidate page's own rule and are never listed, not even as ids. For an
   * interviewer, an application with no candidate record counts here too.
   */
  hidden: number;
  page: number;
  pageSize: number;
  rows: ImpactCandidateRow[];
}

/** The window and the job, as the summary takes them. Everything is optional. */
export interface ImpactSummaryParams {
  from?: string;
  to?: string;
  job?: string | null;
}

/** The number on the page a list sits behind. */
export type ImpactListTarget =
  | { kind: 'step'; step: ImpactStepKey; dropped?: boolean }
  | { kind: 'verdict'; verdict: ImpactVerdictKey; outcome: ImpactOutcomeKey }
  | { kind: 'leave'; stageId: string };

export interface ImpactCandidatesParams extends ImpactSummaryParams {
  target: ImpactListTarget;
  page?: number;
  pageSize?: number;
}
