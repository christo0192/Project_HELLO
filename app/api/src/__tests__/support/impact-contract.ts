/**
 * The business-impact API contract's JSON examples (M031), copied field for
 * field from `.gsd/milestones/M031/API-CONTRACT.md` (fixed 2026-11-09, list
 * visibility added 2026-11-10 as D-M031-5). `.gsd/` is not in the repository,
 * so the examples live here for the route suite to compare every response's
 * fields against. Change them only together with the contract and the page
 * (S6). The figures are the contract's placeholders, not data; no real names.
 */

export const CONTRACT_SUMMARY_EXAMPLE = {
  ok: true,
  meta: {
    generatedAt: '2026-11-09T14:00:00.000Z',
    timezone: 'Asia/Kolkata',
    progressEnabled: true,
    lastPassAt: '2026-11-09T13:55:00.000Z',
    coverage: { checked: 412, total: 415 },
    staleRows: 3,
    labelsConfigured: true,
    unlabelledStages: 0,
    minTimingN: 5,
  },
  filters: {
    from: '2026-08-18', to: '2026-11-09', job: null,
    jobs: [{ id: 'uuid', label: 'Sales Program Advisor' }],
  },
  pipeline: [
    { step: 'came_in', label: 'Came in', reached: 415, ofPrevious: null, ofCameIn: 1, stillHere: 12, droppedHere: 3 },
    { step: 'called', label: 'Christy called', reached: 380, ofPrevious: 0.916, ofCameIn: 0.916, stillHere: 20, droppedHere: 40 },
    { step: 'connected', label: 'Christy connected', reached: 240, ofPrevious: 0.632, ofCameIn: 0.578, stillHere: 0, droppedHere: 10, sub: { label: 'Call answered', reached: 290 } },
    { step: 'scored', label: 'Scored', reached: 230, ofPrevious: 0.958, ofCameIn: 0.554, stillHere: 30, droppedHere: 60 },
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
      { verdict: 'borderline', label: 'Borderline', total: 45, cells: {} },
      { verdict: 'reject', label: 'Reject', total: 150, cells: {} },
      { verdict: 'held', label: 'Held (thin evidence)', total: 9, cells: {} },
      { verdict: 'none', label: 'No verdict', total: 5, cells: {} },
    ],
  },
  leaves: [
    {
      stageId: 'uuid', stageTitle: 'Hello Christy', milestone: 'christy', archived: 95,
      byReasonType: { rejected_by_org: 70, rejected_by_candidate: 15, other: 4, none: 6 },
      topReasons: [{ text: 'Not a fit', count: 40 }],
    },
  ],
  timings: [
    { key: 'entry_to_first_call', label: 'Christy stage to first call', medianDays: 0.2, p90Days: 1.5, n: 380 },
    { key: 'entry_to_verdict', label: 'Christy stage to verdict', medianDays: 1.1, p90Days: 4, n: 230 },
    { key: 'verdict_to_decision', label: 'Verdict to a person deciding', medianDays: 2, p90Days: 9, n: 170 },
    { key: 'christy_to_r1', label: 'Christy stage to R1', medianDays: 6, p90Days: 15, n: 45 },
    { key: 'r1_to_r2', label: 'R1 to R2', medianDays: null, p90Days: null, n: 3 },
    { key: 'r2_to_offer', label: 'R2 to Offer', medianDays: null, p90Days: null, n: 0 },
    { key: 'offer_to_hired', label: 'Offer to Hired', medianDays: null, p90Days: null, n: 0 },
  ],
  cohorts: [
    {
      weekStart: '2026-11-02', ageDays: 7, maturing: true, cameIn: 40,
      shares: { connected: 0.6, scored: 0.55, moved_forward: 0.1, r1: 0.03, r2: 0, offer: 0, hired: 0 },
    },
  ],
  byJob: [
    {
      jobId: 'uuid', label: 'Sales Program Advisor', cameIn: 300,
      shares: { connected: 0.6, scored: 0.55, moved_forward: 0.2, r1: 0.12, r2: 0.07, offer: 0.02, hired: 0.01 },
    },
  ],
} as const;

export const CONTRACT_CANDIDATES_EXAMPLE = {
  ok: true,
  total: 9, hidden: 36, page: 1, pageSize: 50,
  rows: [
    {
      candidateId: 'uuid', name: 'Ananya Rao', roleTitle: 'Sales Program Advisor',
      verdict: 'select', score: 72, provisional: false,
      currentStageTitle: 'R2', currentMilestone: 'r2', status: 'Active',
      enteredChristyAt: '2026-10-20T05:00:00.000Z', lastMoveAt: '2026-11-03T09:30:00.000Z',
    },
  ],
} as const;

/**
 * Every key path of `actual` that the contract's example does not have, and
 * every one the example has that `actual` lacks. Arrays are compared element
 * by element against the example element of the same `step` (the pipeline's
 * `sub` is only on connected), or the example's first element. An empty
 * example object (the contract's elided `cells: {}`) takes its keys from the
 * first sibling that has them, so the verdict rows' cells are still checked.
 */
export function fieldDiff(actual: unknown, example: unknown, path = '$', fallback?: unknown): string[] {
  if (Array.isArray(example)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array`];
    if (example.length === 0) return [];
    return actual.flatMap((item, i) => {
      const step = item && typeof item === 'object' ? (item as Record<string, unknown>).step : undefined;
      const match = example.find((e) => e && typeof e === 'object' && (e as Record<string, unknown>).step === step) ?? example[0];
      return fieldDiff(item, match, `${path}[${i}]`, example[0]);
    });
  }
  if (example !== null && typeof example === 'object') {
    let shape = example as Record<string, unknown>;
    if (Object.keys(shape).length === 0 && fallback && typeof fallback === 'object') shape = fallback as Record<string, unknown>;
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${path}: expected an object`];
    const a = actual as Record<string, unknown>;
    const out: string[] = [];
    for (const key of Object.keys(a)) if (!(key in shape)) out.push(`${path}.${key}: not in the contract`);
    for (const key of Object.keys(shape)) if (!(key in a)) out.push(`${path}.${key}: missing`);
    for (const key of Object.keys(shape)) {
      if (key in a) {
        const fb = fallback && typeof fallback === 'object' ? (fallback as Record<string, unknown>)[key] : undefined;
        out.push(...fieldDiff(a[key], shape[key], `${path}.${key}`, fb));
      }
    }
    return out;
  }
  return [];
}
