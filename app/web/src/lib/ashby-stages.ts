/**
 * The Ashby stage catalogue (M031 S2): the wire types of
 * `GET|POST|PATCH /api/integrations/ashby/mission-control/stage-catalog...`
 * and the words Mission Control's Stages section prints for them.
 *
 * A stage's `milestone` is what the Business impact page counts it as. `null`
 * is "Not labelled", which the page counts as Other, so a stage never drops
 * out of the counts. The API sets Offer, Hired, Archived, R1 to R5, Reference
 * Check and the Christy stage by default and never overwrites an admin's label.
 *
 * No candidate data passes through here: stage titles, Ashby's stage types,
 * plan positions, labels, and counts.
 *
 * A default label follows its stage: every refresh recomputes it, so a stage
 * Ashby renames or retypes, or one no mapping names as its Christy stage any
 * more, takes its new default or none (`redefaulted`). An admin's label stays.
 * A stage Ashby removes from the plan is kept, label and all, with `inPlan`
 * false (`leftPlan` counts them); the API lists it after the live stages.
 */

/** What a stage can count as, in the order the picker offers them (the API's list). */
export const STAGE_MILESTONES = [
  'christy', 'r1', 'r2', 'r3', 'r4', 'r5', 'reference', 'offer', 'hired', 'archived', 'other',
] as const;
export type AshbyStageMilestone = (typeof STAGE_MILESTONES)[number];

export interface AshbyStageCatalogStage {
  /** The opaque Ashby stage id: used to address a label change, never printed. */
  id: string;
  title: string | null;
  /** Ashby's stage type as sent (Lead, PreInterviewScreen, Active, Offer, ...). */
  type: string | null;
  /** Zero-indexed position in the interview plan. */
  order: number | null;
  milestone: AshbyStageMilestone | null;
  milestoneSource: 'admin' | 'default' | null;
  /** False once Ashby removed the stage from its plan. Kept for history; listed after the live stages. */
  inPlan: boolean;
}

export interface AshbyStageCatalogResponse {
  ok: true;
  stages: AshbyStageCatalogStage[];
  enabledMappings: number;
  /** Live mappings whose interview plan has not been read yet. */
  unreadMappings: number;
  truncated: boolean;
}

export type AshbyStageRefreshFailureCode =
  | 'missing_permission'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'client_error'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'malformed_response'
  | 'output_limit'
  | 'logical_failure'
  | 'invalid_request'
  | 'unknown';

export interface AshbyStageCatalogRefresh {
  mappings: { enabled: number; truncated: boolean };
  jobs: { attempted: number; read: number; failed: number; notTried: number };
  failures: Array<{ code: AshbyStageRefreshFailureCode; count: number }>;
  /**
   * defaulted: newly given a default label; redefaulted: a default label that moved to another or to none;
   * leftPlan: stages a plan read no longer lists, kept and newly marked as not in the plan.
   */
  stages: { seen: number; inserted: number; updated: number; defaulted: number; redefaulted: number; leftPlan: number };
  deadlineHit: boolean;
}

export interface AshbyStageCatalogRefreshResponse {
  ok: true;
  refresh: AshbyStageCatalogRefresh;
}

export interface AshbyStageMilestoneUpdateResponse {
  ok: true;
  stage: AshbyStageCatalogStage;
}

// ── Words ───────────────────────────────────────────────────────────────────

export const MILESTONE_LABELS: Readonly<Record<AshbyStageMilestone, string>> = {
  christy: 'Christy stage',
  r1: 'R1',
  r2: 'R2',
  r3: 'R3',
  r4: 'R4',
  r5: 'R5',
  reference: 'Reference check',
  offer: 'Offer',
  hired: 'Hired',
  archived: 'Archived',
  other: 'Other',
};

/** The picker's key for "no label". Never sent: the API takes `null`. */
export const NOT_LABELLED = 'none';
export const NOT_LABELLED_LABEL = 'Not labelled';

export interface MilestoneOption {
  value: string;
  label: string;
  description?: string;
}

/** The picker's options: "Not labelled" first, then the API's list in its order. */
export const MILESTONE_OPTIONS: readonly MilestoneOption[] = [
  { value: NOT_LABELLED, label: NOT_LABELLED_LABEL, description: 'Counted as Other' },
  ...STAGE_MILESTONES.map((m) => ({
    value: m,
    label: MILESTONE_LABELS[m],
    ...(m === 'christy' ? { description: 'Where Christy screens' } : {}),
    ...(m === 'other' ? { description: 'Not a milestone' } : {}),
  })),
];

export function isStageMilestone(raw: unknown): raw is AshbyStageMilestone {
  return typeof raw === 'string' && (STAGE_MILESTONES as readonly string[]).includes(raw);
}

/** The picker key for a stored milestone. */
export function milestoneKey(milestone: AshbyStageMilestone | null): string {
  return milestone ?? NOT_LABELLED;
}

/** The milestone a picker key stands for: `null` for "Not labelled". */
export function milestoneFromKey(key: string): AshbyStageMilestone | null {
  return isStageMilestone(key) ? key : null;
}

export function milestoneLabel(milestone: AshbyStageMilestone | null): string {
  return milestone ? MILESTONE_LABELS[milestone] : NOT_LABELLED_LABEL;
}

/** "Admin", "Default", or a dash for a stage nobody labelled. */
export function milestoneSourceLabel(source: AshbyStageCatalogStage['milestoneSource']): string {
  if (source === 'admin') return 'Admin';
  if (source === 'default') return 'Default';
  return '—';
}

const STAGE_TYPE_LABELS: Readonly<Record<string, string>> = {
  Lead: 'Lead',
  PreInterviewScreen: 'Pre-interview screen',
  Active: 'Active',
  Offer: 'Offer',
  Archived: 'Archived',
  Hired: 'Hired',
};

/** Ashby's stage type in words. A type Ashby adds later prints as Ashby sent it. */
export function stageTypeLabel(type: string | null): string {
  if (!type) return '—';
  return Object.hasOwn(STAGE_TYPE_LABELS, type) ? STAGE_TYPE_LABELS[type] : type;
}

/** The stage's 1-based position in the plan, or a dash. */
export function stagePosition(order: number | null): string {
  return typeof order === 'number' && Number.isInteger(order) && order >= 0 ? String(order + 1) : '—';
}

export function stageTitle(stage: Pick<AshbyStageCatalogStage, 'title'>): string {
  return stage.title && stage.title.trim() ? stage.title : 'Untitled stage';
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

const FAILURE_WORDS: Partial<Record<AshbyStageRefreshFailureCode, string>> = {
  missing_permission: "HELLO's Ashby key is missing the Jobs read permission",
  forbidden: "Ashby refused HELLO's key",
  unauthorized: "Ashby refused HELLO's key",
  rate_limited: 'Ashby is limiting requests just now',
  timeout: "Ashby didn't answer in time",
  network: "Ashby couldn't be reached",
  server_error: 'Ashby had an error of its own',
  not_found: 'Ashby has no plan for a mapped job',
};

/** Why a refresh read fewer jobs than it tried, in words. Never a raw code. */
export function refreshFailureText(failures: AshbyStageCatalogRefresh['failures']): string {
  const words = [...new Set(failures.map((f) => FAILURE_WORDS[f.code] ?? 'Ashby returned an error'))];
  return words.join('; ');
}

export interface RefreshNotice {
  tone: 'success' | 'warning' | 'danger' | 'info';
  text: string;
}

/** What one refresh did, as one notice. */
export function refreshNotice(refresh: AshbyStageCatalogRefresh): RefreshNotice {
  const { jobs, stages, failures } = refresh;
  if (jobs.attempted === 0 && jobs.notTried === 0) {
    return { tone: 'info', text: 'There is no live job mapping, so there was no interview plan to read.' };
  }
  const parts: string[] = [];
  if (jobs.read > 0) {
    const added = stages.inserted > 0 ? `${plural(stages.inserted, 'new stage', 'new stages')}` : 'no new stage';
    const defaulted = stages.defaulted > 0 ? `, ${plural(stages.defaulted, 'labelled', 'labelled')} by default` : '';
    const moved = stages.redefaulted > 0 ? `, ${plural(stages.redefaulted, 'default label', 'default labels')} changed` : '';
    const left = stages.leftPlan > 0 ? `, ${plural(stages.leftPlan, 'stage', 'stages')} no longer in the plan` : '';
    parts.push(`Read ${plural(jobs.read, 'job', 'jobs')} from Ashby: ${plural(stages.seen, 'stage', 'stages')}, ${added}${defaulted}${moved}${left}.`);
  }
  if (jobs.failed > 0) {
    parts.push(`Ashby didn't return the stages for ${jobs.failed} of ${jobs.attempted + jobs.notTried} ${jobs.attempted + jobs.notTried === 1 ? 'job' : 'jobs'}: ${refreshFailureText(failures)}.`);
  }
  if (jobs.notTried > 0) {
    parts.push(`${plural(jobs.notTried, 'job was', 'jobs were')} not read before time ran out. Refresh again.`);
  }
  if (refresh.mappings.truncated) parts.push('Only the five newest live jobs were read.');
  const tone: RefreshNotice['tone'] = jobs.read === 0 ? 'danger' : jobs.failed > 0 || jobs.notTried > 0 ? 'warning' : 'success';
  return { tone, text: parts.join(' ') };
}

/** What a label change did, in one sentence for the status region. */
export function labelSavedText(before: AshbyStageCatalogStage, after: AshbyStageCatalogStage, cleared: boolean): string {
  const title = stageTitle(after);
  if (!cleared) return `${title} now counts as ${milestoneLabel(after.milestone)}.`;
  if (after.milestone) return `${title}'s label is cleared. It counts as ${milestoneLabel(after.milestone)} by default.`;
  return before.milestone
    ? `${title}'s label is cleared. It is not labelled, so it counts as Other.`
    : `${title} is not labelled, so it counts as Other.`;
}
