/**
 * The Business impact client (M031 S6): the two reads of
 * `.gsd/milestones/M031/API-CONTRACT.md`, the query each sends and the shape
 * each accepts. The API itself is built against the same contract elsewhere
 * (S5), so these pin the web half of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());

vi.mock('../api-client', async () => {
  const actual = await vi.importActual<typeof import('../api-client')>('../api-client');
  return { ...actual, apiClient: { request, BASE_URL: 'http://api.test' } };
});

import { ApiError } from '../api-client';
import {
  IMPACT_ROUTES,
  fetchImpactCandidates,
  fetchImpactSummary,
  impactCandidatesPath,
  impactSummaryPath,
  readImpactCandidates,
  readImpactSummary,
  type ImpactSummary,
} from '../impact';

const SUMMARY: ImpactSummary = {
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
  filters: { from: '2026-08-18', to: '2026-11-09', job: null, jobs: [{ id: 'job-1', label: 'Sales Program Advisor' }] },
  pipeline: [
    { step: 'came_in', label: 'Came in', reached: 415, ofPrevious: null, ofCameIn: 1, stillHere: 12, droppedHere: 3 },
    { step: 'connected', label: 'Christy connected', reached: 240, ofPrevious: 0.632, ofCameIn: 0.578, stillHere: 0, droppedHere: 10, sub: { label: 'Call answered', reached: 290 } },
  ],
  verdictOutcomes: {
    columns: [{ key: 'moved_forward', label: 'Moved forward' }],
    rows: [{ verdict: 'select', label: 'Select', total: 21, cells: { moved_forward: 18 } }],
  },
  leaves: [],
  timings: [{ key: 'r1_to_r2', label: 'R1 to R2', medianDays: null, p90Days: null, n: 3 }],
  cohorts: [],
  byJob: [],
};

beforeEach(() => {
  request.mockReset();
});

describe('the summary read', () => {
  it('asks the contract path, with nothing when no filter is set', () => {
    expect(IMPACT_ROUTES.summary).toBe('/api/impact/summary');
    expect(impactSummaryPath({})).toBe('/api/impact/summary');
  });

  it('sends from, to and job exactly as the contract names them', () => {
    expect(impactSummaryPath({ from: '2026-08-18', to: '2026-11-09', job: 'job-1' })).toBe(
      '/api/impact/summary?from=2026-08-18&to=2026-11-09&job=job-1',
    );
  });

  it('leaves out an all-jobs filter rather than sending an empty job', () => {
    expect(impactSummaryPath({ from: '2026-08-18', to: '2026-11-09', job: null })).toBe(
      '/api/impact/summary?from=2026-08-18&to=2026-11-09',
    );
    expect(impactSummaryPath({ job: '' })).toBe('/api/impact/summary');
  });

  it('returns the response it was given when it has the contract shape', async () => {
    request.mockResolvedValue(SUMMARY);
    await expect(fetchImpactSummary({ from: '2026-08-18', to: '2026-11-09' })).resolves.toEqual(SUMMARY);
    expect(request).toHaveBeenCalledWith('/api/impact/summary?from=2026-08-18&to=2026-11-09', expect.any(Object));
  });

  it('passes an abort signal through', async () => {
    request.mockResolvedValue(SUMMARY);
    const controller = new AbortController();
    await fetchImpactSummary({}, controller.signal);
    expect(request.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it('lets an API error through untouched, so the page can tell 403 from 503', async () => {
    request.mockRejectedValue(new ApiError('impact_unavailable', 503, 'impact_unavailable'));
    await expect(fetchImpactSummary({})).rejects.toMatchObject({ status: 503, code: 'impact_unavailable' });
  });

  it.each([
    ['null', null],
    ['ok false', { ...SUMMARY, ok: false }],
    ['no meta', { ...SUMMARY, meta: undefined }],
    ['a pipeline that is not a list', { ...SUMMARY, pipeline: {} }],
    ['no verdict rows', { ...SUMMARY, verdictOutcomes: { columns: [] } }],
    ['no cohorts', { ...SUMMARY, cohorts: undefined }],
    ['a coverage without totals', { ...SUMMARY, meta: { ...SUMMARY.meta, coverage: {} } }],
    ['no jobs list', { ...SUMMARY, filters: { ...SUMMARY.filters, jobs: null } }],
  ])('refuses a response with %s instead of drawing it', (_name, body) => {
    expect(() => readImpactSummary(body)).toThrow(ApiError);
    try {
      readImpactSummary(body);
    } catch (error) {
      expect((error as ApiError).code).toBe('impact_malformed_response');
    }
  });
});

describe('the candidate list read', () => {
  const range = { from: '2026-08-18', to: '2026-11-09', job: null };

  it('asks for the applications that reached a step, with the default reached-only left implicit', () => {
    expect(impactCandidatesPath({ ...range, target: { kind: 'step', step: 'connected' }, page: 1, pageSize: 50 })).toBe(
      '/api/impact/candidates?step=connected&from=2026-08-18&to=2026-11-09&page=1&pageSize=50',
    );
  });

  it('asks for the ones that dropped at a step with dropped=true', () => {
    expect(impactCandidatesPath({ ...range, target: { kind: 'step', step: 'scored', dropped: true } })).toBe(
      '/api/impact/candidates?step=scored&dropped=true&from=2026-08-18&to=2026-11-09',
    );
  });

  it('asks for a verdict and outcome cell', () => {
    expect(
      impactCandidatesPath({ job: 'job-1', target: { kind: 'verdict', verdict: 'reject', outcome: 'moved_forward' }, page: 2 }),
    ).toBe('/api/impact/candidates?verdict=reject&outcome=moved_forward&job=job-1&page=2');
  });

  it('asks for the applications archived at a stage', () => {
    expect(impactCandidatesPath({ target: { kind: 'leave', stageId: 'stage 1' } })).toBe(
      '/api/impact/candidates?leaveStageId=stage+1',
    );
  });

  it('caps the page size at the contract maximum and never sends a page below 1', () => {
    expect(impactCandidatesPath({ target: { kind: 'step', step: 'came_in' }, page: 0, pageSize: 500 })).toBe(
      '/api/impact/candidates?step=came_in&page=1&pageSize=100',
    );
  });

  const ROWS = {
    ok: true,
    total: 1,
    hidden: 0,
    page: 1,
    pageSize: 50,
    rows: [
      {
        candidateId: 'c-1',
        name: 'Asha Verma',
        roleTitle: 'Sales Program Advisor',
        verdict: 'select',
        score: 72,
        provisional: false,
        currentStageTitle: 'R2',
        currentMilestone: 'r2',
        status: 'Active',
        enteredChristyAt: '2026-10-20T05:00:00.000Z',
        lastMoveAt: '2026-11-03T09:30:00.000Z',
      },
    ],
  };

  it('returns a page in the contract shape', async () => {
    request.mockResolvedValue(ROWS);
    await expect(fetchImpactCandidates({ target: { kind: 'step', step: 'hired' } })).resolves.toEqual(ROWS);
    expect(request).toHaveBeenCalledWith('/api/impact/candidates?step=hired', expect.any(Object));
  });

  it('keeps an application that never became a candidate: no candidate id and no name', () => {
    const body = { ...ROWS, total: 2, rows: [...ROWS.rows, { ...ROWS.rows[0], candidateId: null, name: null, verdict: null, score: null }] };
    expect(readImpactCandidates(body).rows[1]).toMatchObject({ candidateId: null, name: null });
  });

  it.each([
    ['no rows', { ...ROWS, rows: undefined }],
    ['no total', { ...ROWS, total: '1' }],
    ['a candidate id that is not text', { ...ROWS, rows: [{ ...ROWS.rows[0], candidateId: 7 }] }],
    ['a row with the candidate id left out', { ...ROWS, rows: [{ ...ROWS.rows[0], candidateId: undefined }] }],
    ['a name that is not text', { ...ROWS, rows: [{ ...ROWS.rows[0], name: 42 }] }],
  ])('refuses a page with %s', (_name, body) => {
    expect(() => readImpactCandidates(body)).toThrow(ApiError);
  });

  // D-M031-5: the list leaves out what the viewer cannot open, and says how many that is.
  it('reads how many applications behind the figure the viewer cannot open', () => {
    const page = readImpactCandidates({ ...ROWS, total: 9, hidden: 36 });
    expect(page.total).toBe(9);
    expect(page.hidden).toBe(36);
  });

  const withoutHidden = (): Record<string, unknown> => {
    const body: Record<string, unknown> = { ...ROWS };
    delete body.hidden;
    return body;
  };

  it.each([
    ['no hidden count', withoutHidden()],
    ['a hidden count left undefined', { ...ROWS, hidden: undefined }],
    ['a negative hidden count', { ...ROWS, hidden: -1 }],
    ['a hidden count that is not a whole number', { ...ROWS, hidden: 1.5 }],
    ['a hidden count sent as text', { ...ROWS, hidden: '3' }],
  ])('refuses a page with %s as malformed', (_name, body) => {
    expect(() => readImpactCandidates(body)).toThrow(ApiError);
    try {
      readImpactCandidates(body);
    } catch (error) {
      expect((error as ApiError).code).toBe('impact_malformed_response');
    }
  });
});
