/**
 * An invented Business impact answer for the unit suites, in the contract's
 * shape (`.gsd/milestones/M031/API-CONTRACT.md`). No real candidate data:
 * every name, job and figure is made up.
 */
import type { ImpactCandidatesPage, ImpactSummary } from '../../../lib/impact';

export function impactSummary(overrides: Partial<ImpactSummary> = {}): ImpactSummary {
  const base: ImpactSummary = {
    ok: true,
    meta: {
      generatedAt: '2026-09-16T06:30:00.000Z',
      timezone: 'Asia/Kolkata',
      progressEnabled: true,
      lastPassAt: '2026-09-16T06:25:00.000Z',
      coverage: { checked: 412, total: 415 },
      staleRows: 0,
      labelsConfigured: true,
      unlabelledStages: 0,
      minTimingN: 5,
    },
    filters: {
      from: '2026-06-29',
      to: '2026-09-16',
      job: null,
      jobs: [
        { id: 'job-spa', label: 'Sales Program Advisor' },
        { id: 'job-ac', label: 'Academic Counsellor' },
      ],
    },
    pipeline: [
      { step: 'came_in', label: 'Came in', reached: 415, ofPrevious: null, ofCameIn: 1, stillHere: 12, droppedHere: 3 },
      { step: 'called', label: 'Christy called', reached: 380, ofPrevious: 0.916, ofCameIn: 0.916, stillHere: 20, droppedHere: 40 },
      { step: 'connected', label: 'Christy connected', reached: 240, ofPrevious: 0.632, ofCameIn: 0.578, stillHere: 0, droppedHere: 10, sub: { label: 'Call answered', reached: 290 } },
      { step: 'scored', label: 'Scored', reached: 230, ofPrevious: 0.958, ofCameIn: 0.554, stillHere: 30, droppedHere: 0 },
      { step: 'decided', label: 'A person decided in Ashby', reached: 170, ofPrevious: 0.739, ofCameIn: 0.41, stillHere: null, droppedHere: 95 },
      { step: 'moved_forward', label: 'Moved forward in Ashby', reached: 75, ofPrevious: 0.441, ofCameIn: 0.181, stillHere: 10, droppedHere: 20 },
      { step: 'r1', label: 'R1 or later', reached: 45, ofPrevious: 0.6, ofCameIn: 0.108, stillHere: 8, droppedHere: 12 },
      { step: 'r2', label: 'R2 or later', reached: 25, ofPrevious: 0.556, ofCameIn: 0.06, stillHere: 5, droppedHere: 8 },
      { step: 'offer', label: 'Offer or later', reached: 9, ofPrevious: 0.36, ofCameIn: 0.022, stillHere: 2, droppedHere: 1 },
      { step: 'hired', label: 'Hired', reached: 6, ofPrevious: 0.667, ofCameIn: 0.014, stillHere: null, droppedHere: null },
    ],
    verdictOutcomes: {
      columns: [
        { key: 'still_christy', label: 'Still in the Christy stage' },
        { key: 'archived_christy', label: 'Archived from the Christy stage' },
        { key: 'moved_forward', label: 'Moved forward' },
        { key: 'r1', label: 'R1 or later' },
        { key: 'r2', label: 'R2 or later' },
        { key: 'offer', label: 'Offer or later' },
        { key: 'hired', label: 'Hired' },
        { key: 'active', label: 'Still active' },
      ],
      rows: [
        { verdict: 'select', label: 'Select', total: 21, cells: { still_christy: 1, archived_christy: 2, moved_forward: 18, r1: 14, r2: 9, offer: 4, hired: 3, active: 6 } },
        { verdict: 'borderline', label: 'Borderline', total: 45, cells: { still_christy: 8, archived_christy: 20, moved_forward: 17, r1: 10, r2: 6, offer: 2, hired: 1, active: 14 } },
        { verdict: 'reject', label: 'Reject', total: 150, cells: { still_christy: 19, archived_christy: 93, moved_forward: 38, r1: 19, r2: 9, offer: 3, hired: 2, active: 30 } },
        { verdict: 'held', label: 'Held (thin evidence)', total: 9, cells: { still_christy: 2, archived_christy: 5, moved_forward: 2, r1: 2, r2: 1, offer: 0, hired: 0, active: 3 } },
        { verdict: 'none', label: 'No verdict', total: 5, cells: { still_christy: 1, archived_christy: 4, moved_forward: 0, r1: 0, r2: 0, offer: 0, hired: 0, active: 1 } },
      ],
    },
    leaves: [
      {
        stageId: 'stage-christy',
        stageTitle: 'Hello Christy',
        milestone: 'christy',
        archived: 95,
        byReasonType: { rejected_by_org: 70, rejected_by_candidate: 15, other: 4, none: 6 },
        topReasons: [
          { text: 'Not a fit for the role', count: 40 },
          { text: 'Salary expectations', count: 12 },
        ],
      },
      {
        stageId: 'stage-r1',
        stageTitle: 'R1',
        milestone: 'r1',
        archived: 12,
        byReasonType: { rejected_by_org: 9, rejected_by_candidate: 3, other: 0, none: 0 },
        topReasons: [],
      },
    ],
    timings: [
      { key: 'entry_to_first_call', label: 'Christy stage to first call', medianDays: 0.2, p90Days: 1.5, n: 380 },
      { key: 'christy_to_r1', label: 'Christy stage to R1', medianDays: 6, p90Days: 15, n: 45 },
      { key: 'r1_to_r2', label: 'R1 to R2', medianDays: null, p90Days: null, n: 3 },
    ],
    cohorts: [
      { weekStart: '2026-08-31', ageDays: 16, maturing: true, cameIn: 40, shares: { connected: 0.6, scored: 0.55, moved_forward: 0.1, r1: 0.03, r2: 0, offer: 0, hired: 0 } },
      { weekStart: '2026-09-14', ageDays: 2, maturing: true, cameIn: 0, shares: { connected: null, scored: null, moved_forward: null, r1: null, r2: null, offer: null, hired: null } },
      { weekStart: '2026-07-06', ageDays: 72, maturing: false, cameIn: 38, shares: { connected: 0.63, scored: 0.58, moved_forward: 0.21, r1: 0.13, r2: 0.08, offer: 0.026, hired: 0.026 } },
    ],
    byJob: [
      { jobId: 'job-spa', label: 'Sales Program Advisor', cameIn: 300, shares: { connected: 0.6, scored: 0.55, moved_forward: 0.2, r1: 0.12, r2: 0.07, offer: 0.02, hired: 0.01 } },
      { jobId: 'job-ac', label: 'Academic Counsellor', cameIn: 115, shares: { connected: 0.5, scored: 0.5, moved_forward: 0.15, r1: 0.08, r2: 0.04, offer: 0.017, hired: 0.017 } },
    ],
  };
  return { ...base, ...overrides };
}

/** The same answer with Ashby stages not read: every Ashby-side figure null. */
export function ashbyUnreadSummary(meta: Partial<ImpactSummary['meta']>): ImpactSummary {
  const base = impactSummary();
  const ashbySide = new Set(['decided', 'moved_forward', 'r1', 'r2', 'offer', 'hired']);
  return {
    ...base,
    meta: { ...base.meta, ...meta },
    pipeline: base.pipeline.map((row) =>
      ashbySide.has(row.step) ? { ...row, reached: null, ofPrevious: null, ofCameIn: null, stillHere: null, droppedHere: null } : row,
    ),
    verdictOutcomes: {
      ...base.verdictOutcomes,
      rows: base.verdictOutcomes.rows.map((row) => ({
        ...row,
        cells: Object.fromEntries(base.verdictOutcomes.columns.map((column) => [column.key, null])),
      })),
    },
    leaves: [],
    timings: base.timings.map((timing) =>
      timing.key === 'entry_to_first_call' ? timing : { ...timing, medianDays: null, p90Days: null, n: 0 },
    ),
  };
}

export function candidatesPage(overrides: Partial<ImpactCandidatesPage> = {}): ImpactCandidatesPage {
  return {
    ok: true,
    total: 2,
    // The viewer can open every candidate behind the figure (D-M031-5).
    hidden: 0,
    page: 1,
    pageSize: 50,
    rows: [
      {
        candidateId: 'cand-1',
        name: 'Ishita Varma',
        roleTitle: 'Sales Program Advisor',
        verdict: 'select',
        score: 74,
        provisional: false,
        currentStageTitle: 'R2',
        currentMilestone: 'r2',
        status: 'Active',
        enteredChristyAt: '2026-08-03T05:00:00.000Z',
        lastMoveAt: '2026-09-01T09:30:00.000Z',
      },
      {
        candidateId: 'cand-2',
        name: 'Rahul Menon',
        roleTitle: 'Sales Program Advisor',
        verdict: 'borderline',
        score: 58,
        provisional: true,
        currentStageTitle: 'Archived',
        currentMilestone: 'archived',
        status: 'Archived',
        enteredChristyAt: '2026-08-10T05:00:00.000Z',
        lastMoveAt: null,
      },
    ],
    ...overrides,
  };
}
