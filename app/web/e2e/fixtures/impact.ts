/**
 * The Business impact fixture (M031): about 400 invented Ashby applications
 * across the harness's two mapped jobs, and the two contract reads computed
 * from them by the contract's own rules (`.gsd/milestones/M031/API-CONTRACT.md`).
 *
 * WHY GENERATED AND AGGREGATED, NOT A FROZEN ANSWER. Every number on the page
 * opens the list behind it, so the summary and the list must agree: pressing
 * "Select, moved forward 18" has to list 18 applications. Computing both from
 * one set of applications makes that true by construction, and lets the
 * filters change the answer the way the real API would.
 *
 * Deterministic: a seeded generator, the harness's frozen clock, no randomness
 * at run time. Invented: names are made-up combinations, figures are made up,
 * and no field the page must not show (email, phone, Ashby ids) exists here at
 * all. Meera Iyer is the one exception: she is the harness's own invented star
 * candidate, so a list row can open a candidate page that exists.
 */

import type {
  ImpactCandidateRow,
  ImpactCandidatesPage,
  ImpactLeave,
  ImpactOutcomeKey,
  ImpactPipelineStep,
  ImpactReasonType,
  ImpactShareKey,
  ImpactStepKey,
  ImpactSummary,
  ImpactTiming,
  ImpactTimingKey,
  ImpactVerdictKey,
} from '../../src/lib/impact-types';
import { STAR_CANDIDATE_ID } from './data';
import { FROZEN_NOW_MS } from './env';

/** What the summary and the list answer with. Tests change it before `goto`. */
export interface ImpactFixtureState {
  /** The summary answers this failure instead. */
  fail: null | { status: number; error: string };
  /** The candidate list answers this failure instead. */
  failCandidates: null | { status: number; error: string };
  progressEnabled: boolean;
  /** `zero`: the worker is on but has checked nothing yet. */
  coverage: 'full' | 'zero';
  unlabelledStages: number;
  /** No application at all. */
  empty: boolean;
  /**
   * Whose candidates the viewer can open, by the candidate page's own rule (D-M031-5). `all`: a
   * role that opens every candidate (the default). `own`: an interviewer who owns some of them.
   * `none`: an interviewer who owns none. The list leaves out what the viewer cannot open, an
   * application with no candidate record included for an interviewer, and counts it in `hidden`.
   * The summary is the same for everyone.
   */
  listScope: 'all' | 'own' | 'none';
}

export function defaultImpactState(): ImpactFixtureState {
  return { fail: null, failCandidates: null, progressEnabled: true, coverage: 'full', unlabelledStages: 0, empty: false, listScope: 'all' };
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const IST_OFFSET = 330 * 60_000;

export const IMPACT_JOBS = [
  { id: 'e2e1ba5e-0000-4000-8000-000000000001', label: 'Senior Backend Engineer' },
  { id: 'e2e1ba5e-0000-4000-8000-000000000002', label: 'Data Analyst' },
] as const;

/** The 18 stages every mapped job shares (live check 2, M031), those the page can name. */
const STAGES = {
  christy: { id: 'e2e1ba5e-5700-4000-8000-000000000005', title: 'Hello Christy', milestone: 'christy' },
  ta: { id: 'e2e1ba5e-5700-4000-8000-000000000006', title: 'TA Screen', milestone: null },
  hm: { id: 'e2e1ba5e-5700-4000-8000-000000000007', title: 'HM Review', milestone: null },
  r1: { id: 'e2e1ba5e-5700-4000-8000-000000000009', title: 'R1', milestone: 'r1' },
  r2: { id: 'e2e1ba5e-5700-4000-8000-000000000010', title: 'R2', milestone: 'r2' },
  offer: { id: 'e2e1ba5e-5700-4000-8000-000000000016', title: 'Offer', milestone: 'offer' },
  hired: { id: 'e2e1ba5e-5700-4000-8000-000000000018', title: 'Hired', milestone: 'hired' },
} as const;
type StageKey = keyof typeof STAGES;
/** Plan order, for "Where candidates leave". */
const LEAVE_ORDER: readonly StageKey[] = ['christy', 'ta', 'hm', 'r1', 'r2', 'offer'];

/** Ashby's reason catalogue, invented. Never free text. */
const REASONS: Readonly<Record<ImpactReasonType, readonly string[]>> = {
  rejected_by_org: ['Not a fit for the role', 'Did not meet the bar', 'Communication', 'Salary expectations', 'Location or shift'],
  rejected_by_candidate: ['Took another offer', 'No longer interested', 'Stopped responding'],
  other: ['Duplicate application', 'Job closed'],
  none: [],
};

const FIRST = ['Aarav', 'Ananya', 'Diya', 'Ishaan', 'Kabir', 'Meher', 'Nikhil', 'Priya', 'Rohan', 'Saanvi', 'Tanvi', 'Vihaan', 'Zara', 'Arjun', 'Kavya', 'Neel', 'Riya', 'Siddharth', 'Aditi', 'Dev', 'Isha', 'Karan', 'Lavanya', 'Manav', 'Naina', 'Omkar', 'Pooja', 'Rahul', 'Sneha', 'Varun', 'Yash', 'Esha'];
const LAST = ['Acharya', 'Bhat', 'Chandran', 'Dutta', 'Fernandes', 'Gokhale', 'Hegde', 'Iyengar', 'Joshi', 'Kulkarni', 'Lal', 'Mehta', 'Nair', 'Oberoi', 'Pillai', 'Rao', 'Saxena', 'Thakur', 'Upadhyay', 'Varghese', 'Wadia', 'Yadav'];

/** mulberry32: a small seeded generator, so every run builds the same world. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Application {
  /** Null for a stuck import: HELLO imported the application but it never became a candidate. */
  candidateId: string | null;
  name: string | null;
  /** The candidate's owner is the viewer, so an interviewer viewer can open it (`listScope: 'own'`). */
  ownedByViewer: boolean;
  jobId: string;
  roleTitle: string;
  enteredMs: number;
  /** The IST date it entered the Christy stage: the cohort date. */
  cohortDate: string;
  called: boolean;
  answered: boolean;
  connected: boolean;
  /** Null: never connected, so not in the verdict table at all. */
  verdict: ImpactVerdictKey | null;
  score: number | null;
  provisional: boolean;
  leftChristy: boolean;
  movedForward: boolean;
  /** 0 the Christy stage, 1 a stage after it, 2 R1, 3 R2, 4 Offer, 5 Hired. */
  furthest: number;
  status: 'Active' | 'Archived' | 'Hired';
  archivedAt: StageKey | null;
  reasonType: ImpactReasonType | null;
  reason: string | null;
  currentStage: StageKey | 'archived';
  lastMoveMs: number | null;
  days: Partial<Record<ImpactTimingKey, number>>;
}

const istDate = (ms: number) => new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
/** The IST Monday of an IST date. */
function istMonday(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const back = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - back * DAY).toISOString().slice(0, 10);
}

const FURTHEST_STAGE: readonly StageKey[] = ['christy', 'ta', 'r1', 'r2', 'offer', 'hired'];

function build(): Application[] {
  const rand = seeded(31_031);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const chance = (p: number) => rand() < p;
  const apps: Application[] = [];

  for (let i = 0; i < 412; i += 1) {
    const job = chance(0.62) ? IMPACT_JOBS[0] : IMPACT_JOBS[1];
    // Over the last 16 weeks, a little heavier lately.
    const ageDays = 112 * rand() ** 1.15;
    const enteredMs = FROZEN_NOW_MS - ageDays * DAY;
    const maturity = Math.min(1, ageDays / 30);
    const days: Application['days'] = {};

    const called = ageDays < 0.4 ? chance(0.4) : chance(0.94);
    const connected = called && chance(0.64);
    const answered = connected || (called && chance(0.3));
    let verdict: ImpactVerdictKey | null = null;
    if (connected) {
      const r = rand();
      verdict = r < 0.04 ? 'held' : r < 0.06 ? 'none' : r < 0.155 ? 'select' : r < 0.36 ? 'borderline' : 'reject';
    }
    const scored = verdict === 'select' || verdict === 'borderline' || verdict === 'reject';
    const score =
      verdict === 'select' ? 65 + Math.floor(rand() * 21)
        : verdict === 'borderline' ? 45 + Math.floor(rand() * 20)
          : verdict === 'reject' ? 18 + Math.floor(rand() * 27)
            : verdict === 'held' ? 35 + Math.floor(rand() * 25)
              : null;
    const provisional = scored && chance(0.12);

    if (called) days.entry_to_first_call = Math.min(ageDays, 0.05 + 3 * rand() * rand());
    if (scored) days.entry_to_verdict = Math.min(ageDays, (days.entry_to_first_call ?? 0) + 0.1 + 4 * rand() * rand());

    const leaveP = { select: 0.9, borderline: 0.8, reject: 0.86, held: 0.7, none: 0.75 } as const;
    const forwardP = { select: 0.86, borderline: 0.45, reject: 0.09, held: 0.3, none: 0.15 } as const;
    const leftChristy = chance((verdict ? leaveP[verdict] : 0.55) * Math.min(1, ageDays / 6));
    const movedForward = leftChristy && chance(verdict ? forwardP[verdict] : 0.03);

    let furthest = movedForward ? 1 : 0;
    if (movedForward && chance((verdict === 'select' ? 0.8 : 0.62) * maturity)) furthest = 2;
    if (furthest === 2 && chance(0.6 * maturity)) furthest = 3;
    if (furthest === 3 && chance(0.55 * maturity)) furthest = 4;
    if (furthest === 4 && chance(0.7 * maturity)) furthest = 5;

    let status: Application['status'] = 'Active';
    if (furthest === 5) status = 'Hired';
    else if (leftChristy && !movedForward) status = 'Archived';
    else if (movedForward && chance(0.6 * maturity + 0.05)) status = 'Archived';

    let archivedAt: StageKey | null = null;
    if (status === 'Archived') archivedAt = movedForward ? (furthest === 1 ? pick(['ta', 'hm'] as const) : FURTHEST_STAGE[furthest]!) : 'christy';
    let reasonType: ImpactReasonType | null = null;
    let reason: string | null = null;
    if (archivedAt) {
      const r = rand();
      reasonType = r < 0.72 ? 'rejected_by_org' : r < 0.89 ? 'rejected_by_candidate' : r < 0.93 ? 'other' : 'none';
      reason = reasonType === 'none' ? null : pick(REASONS[reasonType]);
    }

    // The steps after Christy, each after the one before it and before now.
    let clock = days.entry_to_verdict ?? days.entry_to_first_call ?? 0.5;
    let lastMoveMs: number | null = null;
    if (leftChristy) {
      const decision = 0.5 + 12 * rand() * rand();
      if (scored) days.verdict_to_decision = decision;
      clock += decision;
      if (furthest >= 2) {
        clock += 1 + 9 * rand();
        days.christy_to_r1 = clock;
      }
      if (furthest >= 3) {
        const step = 2 + 8 * rand();
        days.r1_to_r2 = step;
        clock += step;
      }
      if (furthest >= 4) {
        const step = 3 + 10 * rand();
        days.r2_to_offer = step;
        clock += step;
      }
      if (furthest >= 5) {
        const step = 2 + 7 * rand();
        days.offer_to_hired = step;
        clock += step;
      }
      lastMoveMs = Math.min(FROZEN_NOW_MS - HOUR, enteredMs + clock * DAY);
    }

    apps.push({
      candidateId: `e2e1ba5e-ca00-4000-8000-${String(i + 1).padStart(12, '0')}`,
      name: `${pick(FIRST)} ${pick(LAST)}`,
      // Every third, by position: it draws nothing from the generator, so every figure stays as it was.
      ownedByViewer: i % 3 === 0,
      jobId: job.id,
      roleTitle: job.label,
      enteredMs,
      cohortDate: istDate(enteredMs),
      called,
      answered,
      connected,
      verdict,
      score,
      provisional,
      leftChristy,
      movedForward,
      furthest,
      status,
      archivedAt,
      reasonType,
      reason,
      currentStage: status === 'Archived' ? 'archived' : FURTHEST_STAGE[furthest]!,
      lastMoveMs,
      days,
    });
  }

  // The harness's star candidate: a Select at R1 on the backend job, moved most recently, so a list of
  // Selects that moved forward opens on her and her name leads to a candidate page that exists.
  const enteredMs = FROZEN_NOW_MS - 32 * DAY;
  apps[0] = {
    ...apps[0]!,
    candidateId: STAR_CANDIDATE_ID,
    name: 'Meera Iyer',
    // Hers, so an interviewer's list still has a row that opens a candidate page that exists.
    ownedByViewer: true,
    jobId: IMPACT_JOBS[0].id,
    roleTitle: IMPACT_JOBS[0].label,
    enteredMs,
    cohortDate: istDate(enteredMs),
    called: true,
    answered: true,
    connected: true,
    verdict: 'select',
    score: 86,
    provisional: false,
    leftChristy: true,
    movedForward: true,
    furthest: 2,
    status: 'Active',
    archivedAt: null,
    reasonType: null,
    reason: null,
    currentStage: 'r1',
    lastMoveMs: FROZEN_NOW_MS - 2 * HOUR,
    days: { entry_to_first_call: 0.2, entry_to_verdict: 0.4, verdict_to_decision: 3, christy_to_r1: 12 },
  };

  // A stuck import (plan section 4): the newest application Christy never called stands for one HELLO
  // imported that never became a candidate, so it has no candidate record and no name. It still came
  // in, so its lists must still show it. Only its two ids change: every count stays as it was.
  const stuck = apps.filter((a) => !a.called).sort((x, y) => y.enteredMs - x.enteredMs)[0]!;
  stuck.candidateId = null;
  stuck.name = null;
  return apps;
}

/**
 * Built on first use, not at import: `data.ts` imports this file for the dataset's
 * defaults, and this file reads the star candidate's id from it.
 */
let built: Application[] | null = null;
const applications = (): Application[] => (built ??= build());

/** The IST Monday of the week the stuck import came in: its cohort's list shows it on the first page. */
export function stuckImportWeek(): string {
  const stuck = applications().find((a) => a.candidateId === null);
  if (!stuck) throw new Error('the impact fixture has no stuck import');
  return istMonday(stuck.cohortDate);
}

// ── The rules ────────────────────────────────────────────────────────────

const STEP_LABEL: Readonly<Record<ImpactStepKey, string>> = {
  came_in: 'Came in',
  called: 'Christy called',
  connected: 'Christy connected',
  scored: 'Scored',
  decided: 'A person decided in Ashby',
  moved_forward: 'Moved forward in Ashby',
  r1: 'R1 or later',
  r2: 'R2 or later',
  offer: 'Offer or later',
  hired: 'Hired',
};
const STEPS = Object.keys(STEP_LABEL) as ImpactStepKey[];
/** decided onward: what Ashby has to say. */
const ASHBY_SIDE = STEPS.indexOf('decided');

const isScored = (a: Application) => a.verdict === 'select' || a.verdict === 'borderline' || a.verdict === 'reject';

/** The furthest pipeline step an application reached, every step nested in the one before. */
function furthestStep(a: Application): number {
  if (!a.called) return 0;
  if (!a.connected) return 1;
  if (!isScored(a)) return 2;
  if (!a.leftChristy) return 3;
  if (!a.movedForward) return 4;
  if (a.furthest < 2) return 5;
  return 4 + a.furthest; // r1 6, r2 7, offer 8, hired 9
}

const stoppedStill = (a: Application) => a.status === 'Active';

const OUTCOME: Readonly<Record<ImpactOutcomeKey, (a: Application) => boolean>> = {
  still_christy: (a) => !a.leftChristy,
  archived_christy: (a) => a.leftChristy && !a.movedForward,
  moved_forward: (a) => a.movedForward,
  r1: (a) => a.movedForward && a.furthest >= 2,
  r2: (a) => a.movedForward && a.furthest >= 3,
  offer: (a) => a.movedForward && a.furthest >= 4,
  hired: (a) => a.furthest === 5,
  active: (a) => a.status === 'Active',
};
const OUTCOME_LABEL: Readonly<Record<ImpactOutcomeKey, string>> = {
  still_christy: 'Still in the Christy stage',
  archived_christy: 'Archived from the Christy stage',
  moved_forward: 'Moved forward',
  r1: 'R1 or later',
  r2: 'R2 or later',
  offer: 'Offer or later',
  hired: 'Hired',
  active: 'Still active',
};
const VERDICT_LABEL: Readonly<Record<ImpactVerdictKey, string>> = {
  select: 'Select',
  borderline: 'Borderline',
  reject: 'Reject',
  held: 'Held (thin evidence)',
  none: 'No verdict',
};
const SHARE_STEP: Readonly<Record<ImpactShareKey, ImpactStepKey>> = {
  connected: 'connected',
  scored: 'scored',
  moved_forward: 'moved_forward',
  r1: 'r1',
  r2: 'r2',
  offer: 'offer',
  hired: 'hired',
};
const TIMING_LABEL: Readonly<Record<ImpactTimingKey, string>> = {
  entry_to_first_call: 'Christy stage to first call',
  entry_to_verdict: 'Christy stage to verdict',
  verdict_to_decision: 'Verdict to a person deciding',
  christy_to_r1: 'Christy stage to R1',
  r1_to_r2: 'R1 to R2',
  r2_to_offer: 'R2 to Offer',
  offer_to_hired: 'Offer to Hired',
};
/** The timings Ashby has to supply. */
const ASHBY_TIMINGS: ReadonlySet<ImpactTimingKey> = new Set(['verdict_to_decision', 'christy_to_r1', 'r1_to_r2', 'r2_to_offer', 'offer_to_hired']);
const MIN_TIMING_N = 5;

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const share = (part: number, whole: number) => (whole > 0 ? round3(part / whole) : null);

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

interface Window {
  from: string;
  to: string;
  job: string | null;
}

function windowOf(query: URLSearchParams): Window | null {
  const nowIst = istDate(FROZEN_NOW_MS);
  const from = query.get('from') ?? istMonday(new Date(Date.parse(`${nowIst}T00:00:00Z`) - 77 * DAY).toISOString().slice(0, 10));
  const to = query.get('to') ?? nowIst;
  const job = query.get('job');
  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!isDate(from) || !isDate(to) || from > to) return null;
  if (job && !IMPACT_JOBS.some((option) => option.id === job)) return null;
  return { from, to, job };
}

function inWindow(state: ImpactFixtureState, range: Window): Application[] {
  if (state.empty) return [];
  return applications().filter((a) => a.cohortDate >= range.from && a.cohortDate <= range.to && (!range.job || a.jobId === range.job));
}

const ashbyRead = (state: ImpactFixtureState) => state.progressEnabled && state.coverage === 'full';

function pipelineOf(apps: Application[], read: boolean): ImpactPipelineStep[] {
  const steps = apps.map(furthestStep);
  const reached = STEPS.map((_, index) => steps.filter((s) => s >= index).length);
  return STEPS.map((step, index) => {
    const ashby = index >= ASHBY_SIDE;
    const stopped = apps.filter((_, i) => steps[i] === index);
    const row: ImpactPipelineStep = {
      step,
      label: STEP_LABEL[step],
      reached: ashby && !read ? null : reached[index]!,
      ofPrevious: index === 0 || (ashby && !read) ? null : share(reached[index]!, reached[index - 1]!),
      ofCameIn: ashby && !read ? null : share(reached[index]!, reached[0]!),
      // Whether an application stopped or is still waiting is Ashby's to say.
      stillHere: !read || step === 'decided' || step === 'hired' ? null : stopped.filter(stoppedStill).length,
      droppedHere: !read || step === 'hired' ? null : stopped.filter((a) => !stoppedStill(a)).length,
    };
    if (step === 'connected') row.sub = { label: 'Call answered', reached: apps.filter((a) => a.answered).length };
    return row;
  });
}

function sharesOf(apps: Application[], read: boolean): Record<ImpactShareKey, number | null> {
  const steps = apps.map(furthestStep);
  return Object.fromEntries(
    (Object.keys(SHARE_STEP) as ImpactShareKey[]).map((key) => {
      const index = STEPS.indexOf(SHARE_STEP[key]);
      if (index >= ASHBY_SIDE && !read) return [key, null];
      return [key, share(steps.filter((s) => s >= index).length, apps.length)];
    }),
  ) as Record<ImpactShareKey, number | null>;
}

function timingsOf(apps: Application[], read: boolean): ImpactTiming[] {
  return (Object.keys(TIMING_LABEL) as ImpactTimingKey[]).map((key) => {
    if (ASHBY_TIMINGS.has(key) && !read) return { key, label: TIMING_LABEL[key], medianDays: null, p90Days: null, n: 0 };
    const values = apps.map((a) => a.days[key]).filter((v): v is number => typeof v === 'number').sort((x, y) => x - y);
    const n = values.length;
    const small = n < MIN_TIMING_N;
    return {
      key,
      label: TIMING_LABEL[key],
      medianDays: small ? null : Math.round(quantile(values, 0.5) * 10) / 10,
      p90Days: small ? null : Math.round(quantile(values, 0.9) * 10) / 10,
      n,
    };
  });
}

function leavesOf(apps: Application[], read: boolean): ImpactLeave[] {
  if (!read) return [];
  return LEAVE_ORDER.map((key) => {
    const archived = apps.filter((a) => a.archivedAt === key);
    const byReasonType: Record<ImpactReasonType, number> = { rejected_by_org: 0, rejected_by_candidate: 0, other: 0, none: 0 };
    const counts = new Map<string, number>();
    for (const a of archived) {
      if (a.reasonType) byReasonType[a.reasonType] += 1;
      if (a.reason) counts.set(a.reason, (counts.get(a.reason) ?? 0) + 1);
    }
    return {
      stageId: STAGES[key].id,
      stageTitle: STAGES[key].title,
      milestone: STAGES[key].milestone,
      archived: archived.length,
      byReasonType,
      topReasons: [...counts.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, 5)
        .map(([text, count]) => ({ text, count })),
    };
  }).filter((leave) => leave.archived > 0);
}

export function impactSummary(query: URLSearchParams, state: ImpactFixtureState): { status: number; json: unknown } {
  if (state.fail) return { status: state.fail.status, json: { ok: false, error: state.fail.error } };
  const range = windowOf(query);
  if (!range) return { status: 400, json: { ok: false, error: 'invalid_filter' } };
  const read = ashbyRead(state);
  const apps = inWindow(state, range);
  const total = state.empty ? 0 : applications().length;
  const verdictApps = apps.filter((a) => a.verdict !== null);
  const columns = (Object.keys(OUTCOME) as ImpactOutcomeKey[]).map((key) => ({ key, label: OUTCOME_LABEL[key] }));

  const weeks = new Map<string, Application[]>();
  for (const a of apps) {
    const week = istMonday(a.cohortDate);
    weeks.set(week, [...(weeks.get(week) ?? []), a]);
  }

  const summary: ImpactSummary = {
    ok: true,
    meta: {
      generatedAt: new Date(FROZEN_NOW_MS).toISOString(),
      timezone: 'Asia/Kolkata',
      progressEnabled: state.progressEnabled,
      lastPassAt: read ? new Date(FROZEN_NOW_MS - 5 * 60_000).toISOString() : null,
      coverage: { checked: read ? Math.max(0, total - 3) : 0, total },
      staleRows: read && total > 0 ? 3 : 0,
      labelsConfigured: state.unlabelledStages === 0,
      unlabelledStages: state.unlabelledStages,
      minTimingN: MIN_TIMING_N,
    },
    filters: { from: range.from, to: range.to, job: range.job, jobs: IMPACT_JOBS.map((job) => ({ ...job })) },
    pipeline: pipelineOf(apps, read),
    verdictOutcomes: {
      columns,
      rows: (Object.keys(VERDICT_LABEL) as ImpactVerdictKey[]).map((verdict) => {
        const rows = verdictApps.filter((a) => a.verdict === verdict);
        return {
          verdict,
          label: VERDICT_LABEL[verdict],
          total: rows.length,
          cells: Object.fromEntries(columns.map(({ key }) => [key, read ? rows.filter(OUTCOME[key]).length : null])),
        };
      }),
    },
    leaves: leavesOf(apps, read),
    timings: timingsOf(apps, read),
    cohorts: [...weeks.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([weekStart, rows]) => {
        const ageDays = Math.floor((FROZEN_NOW_MS + IST_OFFSET - Date.parse(`${weekStart}T00:00:00Z`)) / DAY);
        return { weekStart, ageDays, maturing: ageDays < 42, cameIn: rows.length, shares: sharesOf(rows, read) };
      }),
    byJob: IMPACT_JOBS.filter((job) => !range.job || job.id === range.job)
      .map((job) => {
        const rows = apps.filter((a) => a.jobId === job.id);
        return { jobId: job.id, label: job.label, cameIn: rows.length, shares: sharesOf(rows, read) };
      })
      .filter((row) => row.cameIn > 0),
  };
  return { status: 200, json: summary };
}

const STAGE_TITLE = (a: Application) => (a.currentStage === 'archived' ? 'Archived' : STAGES[a.currentStage].title);
const STAGE_MILESTONE = (a: Application) => (a.currentStage === 'archived' ? 'archived' : STAGES[a.currentStage].milestone);

function rowOf(a: Application): ImpactCandidateRow {
  return {
    candidateId: a.candidateId,
    name: a.name,
    roleTitle: a.roleTitle,
    verdict: a.verdict,
    score: a.score,
    provisional: a.provisional,
    currentStageTitle: STAGE_TITLE(a),
    currentMilestone: STAGE_MILESTONE(a),
    status: a.status,
    enteredChristyAt: new Date(a.enteredMs).toISOString(),
    lastMoveAt: a.lastMoveMs === null ? null : new Date(a.lastMoveMs).toISOString(),
  };
}

/**
 * Whether the viewer can open the application's candidate. A role that opens every candidate sees
 * an application with no candidate record too; an interviewer sees only the candidates they own.
 */
function canOpen(a: Application, scope: ImpactFixtureState['listScope']): boolean {
  if (scope === 'all') return true;
  if (scope === 'none') return false;
  return a.candidateId !== null && a.ownedByViewer;
}

export function impactCandidates(query: URLSearchParams, state: ImpactFixtureState): { status: number; json: unknown } {
  if (state.failCandidates) return { status: state.failCandidates.status, json: { ok: false, error: state.failCandidates.error } };
  const range = windowOf(query);
  if (!range) return { status: 400, json: { ok: false, error: 'invalid_filter' } };
  const read = ashbyRead(state);
  const apps = inWindow(state, range);
  const step = query.get('step') as ImpactStepKey | null;
  const verdict = query.get('verdict') as ImpactVerdictKey | null;
  const outcome = query.get('outcome') as ImpactOutcomeKey | null;
  const stageId = query.get('leaveStageId');
  const dropped = query.get('dropped') === 'true';

  let matches: Application[];
  if (step !== null) {
    const index = STEPS.indexOf(step);
    if (index < 0) return { status: 400, json: { ok: false, error: 'invalid_filter' } };
    if (index >= ASHBY_SIDE && !read) matches = [];
    else if (dropped) matches = read ? apps.filter((a) => furthestStep(a) === index && !stoppedStill(a)) : [];
    else matches = apps.filter((a) => furthestStep(a) >= index);
  } else if (verdict !== null && outcome !== null) {
    if (!(verdict in VERDICT_LABEL) || !(outcome in OUTCOME)) return { status: 400, json: { ok: false, error: 'invalid_filter' } };
    matches = read ? apps.filter((a) => a.verdict === verdict && OUTCOME[outcome](a)) : [];
  } else if (stageId !== null) {
    const key = (Object.keys(STAGES) as StageKey[]).find((k) => STAGES[k].id === stageId);
    matches = key && read ? apps.filter((a) => a.archivedAt === key) : [];
  } else {
    return { status: 400, json: { ok: false, error: 'invalid_filter' } };
  }

  // The candidate page's own rule (D-M031-5): what the viewer cannot open is never listed, only
  // counted, so `total + hidden` is still the figure the list sits behind.
  const visible = matches.filter((a) => canOpen(a, state.listScope));
  const hidden = matches.length - visible.length;

  const listed = [...visible].sort((x, y) => (y.lastMoveMs ?? 0) - (x.lastMoveMs ?? 0) || y.enteredMs - x.enteredMs);
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize') ?? 50) || 50));
  const pageCount = Math.max(1, Math.ceil(listed.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(query.get('page') ?? 1) || 1));
  const answer: ImpactCandidatesPage = {
    ok: true,
    total: listed.length,
    hidden,
    page,
    pageSize,
    rows: listed.slice((page - 1) * pageSize, page * pageSize).map(rowOf),
  };
  return { status: 200, json: answer };
}
