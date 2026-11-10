/**
 * How the Business impact page prints its figures (M031 S6). These are the
 * rules a reader cannot audit from the screen: a share is never over 100%, a
 * figure that is not known is a dash and never a 0, a timing on a small n is
 * not printed, and a young week says it is still maturing.
 */
import { describe, expect, it } from 'vitest';
import {
  DASH,
  IMPACT_ALL_FROM,
  ashbyStagesRead,
  cohortWeekLabel,
  formatCount,
  formatDays,
  formatShare,
  freshnessLine,
  milestoneLabel,
  reasonTypeRows,
  shareOf,
  staleLine,
  timingView,
  unlabelledNotice,
  weeksFrom,
  weeksPhrase,
  weeksWindow,
} from '../impact-format';
import type { ImpactMeta } from '../impact';

const META: ImpactMeta = {
  generatedAt: '2026-11-09T14:00:00.000Z',
  timezone: 'Asia/Kolkata',
  progressEnabled: true,
  lastPassAt: '2026-11-09T13:55:00.000Z',
  coverage: { checked: 412, total: 415 },
  staleRows: 0,
  labelsConfigured: true,
  unlabelledStages: 0,
  minTimingN: 5,
};

describe('counts', () => {
  it('prints a count with grouping, and zero as zero', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(415)).toBe('415');
    expect(formatCount(12345)).toMatch(/^12.?345$/);
  });

  it('prints a dash, never a 0, for a figure that is not known', () => {
    expect(formatCount(null)).toBe(DASH);
    expect(formatCount(undefined)).toBe(DASH);
    expect(formatCount(Number.NaN)).toBe(DASH);
  });
});

describe('shares', () => {
  it('prints whole percents from 10%', () => {
    expect(formatShare(1)).toBe('100%');
    expect(formatShare(0.916)).toBe('92%');
    expect(formatShare(0.1)).toBe('10%');
  });

  it('keeps one decimal under 10%, where the late steps live', () => {
    expect(formatShare(0.014)).toBe('1.4%');
    expect(formatShare(0.06)).toBe('6%');
    expect(formatShare(0.0004)).toBe('<0.1%');
    expect(formatShare(0)).toBe('0%');
  });

  it('prints a dash for a share that does not apply', () => {
    expect(formatShare(null)).toBe(DASH);
    expect(formatShare(undefined)).toBe(DASH);
  });

  it('never prints a share over 100% or below 0: that is a bug, and it shows a dash', () => {
    expect(formatShare(1.36)).toBe(DASH);
    expect(formatShare(-0.2)).toBe(DASH);
    expect(formatShare(Number.POSITIVE_INFINITY)).toBe(DASH);
  });

  it('works out a share of a row, and refuses one that has no whole or is bigger than it', () => {
    expect(shareOf(18, 21)).toBeCloseTo(0.857, 3);
    expect(shareOf(0, 21)).toBe(0);
    expect(shareOf(5, 0)).toBeNull();
    expect(shareOf(null, 21)).toBeNull();
    expect(shareOf(undefined, 21)).toBeNull();
    expect(shareOf(22, 21)).toBeNull();
  });
});

describe('time between steps', () => {
  it('prints days with one decimal under 10 and whole days from 10', () => {
    expect(formatDays(0.2)).toBe('0.2');
    expect(formatDays(1.1)).toBe('1.1');
    expect(formatDays(2)).toBe('2');
    expect(formatDays(15.4)).toBe('15');
    expect(formatDays(null)).toBe(DASH);
  });

  const READ = { minTimingN: 5, ashbyRead: true };

  it('prints a timing with its n', () => {
    expect(timingView({ key: 'christy_to_r1', label: 'Christy stage to R1', medianDays: 6, p90Days: 15, n: 45 }, READ)).toEqual({
      median: '6',
      p90: '15',
      n: '45',
      state: 'known',
    });
  });

  it('says n too small, and keeps n, when the median is withheld', () => {
    expect(timingView({ key: 'r1_to_r2', label: 'R1 to R2', medianDays: null, p90Days: null, n: 3 }, READ)).toEqual({
      median: 'n too small',
      p90: DASH,
      n: '3',
      state: 'too_small',
    });
    expect(timingView({ key: 'r2_to_offer', label: 'R2 to Offer', medianDays: null, p90Days: null, n: 0 }, READ).n).toBe('0');
  });

  it('calls a missing median with n at the floor or above not known, never too small', () => {
    expect(timingView({ key: 'christy_to_r1', label: 'Christy stage to R1', medianDays: null, p90Days: null, n: 45 }, READ)).toEqual({
      median: DASH,
      p90: DASH,
      n: '45',
      state: 'unknown',
    });
    expect(timingView({ key: 'christy_to_r1', label: 'Christy stage to R1', medianDays: null, p90Days: null, n: 5 }, READ).state).toBe(
      'unknown',
    );
  });

  it('prints every column of an Ashby-side timing as a dash while Ashby stages are not read, even an n of 0', () => {
    const unread = { minTimingN: 5, ashbyRead: false };
    for (const key of ['verdict_to_decision', 'christy_to_r1', 'r1_to_r2', 'r2_to_offer', 'offer_to_hired'] as const) {
      expect(timingView({ key, label: key, medianDays: null, p90Days: null, n: 0 }, unread)).toEqual({
        median: DASH,
        p90: DASH,
        n: DASH,
        state: 'unknown',
      });
    }
    // Christy's own timings are counted as usual.
    expect(timingView({ key: 'entry_to_first_call', label: 'First call', medianDays: 0.2, p90Days: 1.5, n: 380 }, unread).state).toBe('known');
    expect(timingView({ key: 'entry_to_verdict', label: 'Verdict', medianDays: null, p90Days: null, n: 2 }, unread).state).toBe('too_small');
  });
});

describe('whether Ashby stages are being read', () => {
  it('is true only with progress on and something checked', () => {
    expect(ashbyStagesRead(META)).toBe(true);
    expect(ashbyStagesRead({ ...META, progressEnabled: false })).toBe(false);
    expect(ashbyStagesRead({ ...META, coverage: { checked: 0, total: 415 } })).toBe(false);
  });
});

describe('the freshness line', () => {
  const now = new Date('2026-11-09T14:00:00.000Z');

  it('says when Ashby stages were checked and how many of the applications', () => {
    expect(freshnessLine(META, now)).toBe('Ashby stages checked 5 minutes ago, 412 of 415 applications');
  });

  it('says they have not been checked when there has been no pass', () => {
    expect(freshnessLine({ ...META, lastPassAt: null, coverage: { checked: 0, total: 415 } }, now)).toBe(
      'Ashby stages not checked yet, 0 of 415 applications',
    );
  });

  it('names the rows that are due a fresh check, and says nothing when none are', () => {
    expect(staleLine(META)).toBeNull();
    expect(staleLine({ ...META, staleRows: 1 })).toBe('1 application is due a fresh check.');
    expect(staleLine({ ...META, staleRows: 3 })).toBe('3 applications are due a fresh check.');
  });

  it('names unlabelled stages, in the singular and the plural', () => {
    expect(unlabelledNotice(META)).toBeNull();
    expect(unlabelledNotice({ ...META, unlabelledStages: 1 })).toBe(
      '1 Ashby stage has no milestone label yet. Applications in it show as Other and do not count towards R1, R2 or Offer until an admin labels it.',
    );
    expect(unlabelledNotice({ ...META, unlabelledStages: 3 })).toBe(
      '3 Ashby stages have no milestone label yet. Applications in them show as Other and do not count towards R1, R2 or Offer until an admin labels them.',
    );
  });
});

describe('the weeks filter', () => {
  // Wednesday 16 Sep 2026, 12:00 IST.
  const now = new Date('2026-09-16T06:30:00.000Z');

  it('reads the address, falling back to 12 weeks', () => {
    expect(weeksFrom('4')).toBe('4');
    expect(weeksFrom('26')).toBe('26');
    expect(weeksFrom('all')).toBe('all');
    expect(weeksFrom(null)).toBe('12');
    expect(weeksFrom('13')).toBe('12');
  });

  it('starts on the Monday of the IST week, so the current week counts as one of them', () => {
    expect(weeksWindow('4', now)).toEqual({ from: '2026-08-24', to: '2026-09-16' });
    expect(weeksWindow('12', now)).toEqual({ from: '2026-06-29', to: '2026-09-16' });
    expect(weeksWindow('26', now)).toEqual({ from: '2026-03-23', to: '2026-09-16' });
  });

  it('asks for everything from before HELLO imported any Ashby application', () => {
    expect(weeksWindow('all', now)).toEqual({ from: IMPACT_ALL_FROM, to: '2026-09-16' });
    expect(IMPACT_ALL_FROM < '2026-08-14').toBe(true);
  });

  it('turns the window into words', () => {
    expect(weeksPhrase('4')).toBe('Last 4 weeks');
    expect(weeksPhrase('all')).toBe('All weeks');
  });

  it('dates the IST week of midnight IST, whatever the clock zone', () => {
    // 18:45 UTC on Sunday is 00:15 IST on Monday.
    expect(weeksWindow('4', new Date('2026-09-13T18:45:00.000Z'))).toEqual({ from: '2026-08-24', to: '2026-09-14' });
  });
});

describe('cohorts, stages and reasons', () => {
  it('labels a cohort by its IST Monday', () => {
    expect(cohortWeekLabel('2026-11-02')).toBe('2 Nov 2026');
    expect(cohortWeekLabel('not a date')).toBe(DASH);
  });

  it('names a milestone, and says nothing when there is none', () => {
    expect(milestoneLabel('christy')).toBe('Christy stage');
    expect(milestoneLabel('r1')).toBe('R1');
    expect(milestoneLabel('offer')).toBe('Offer');
    expect(milestoneLabel('reference_check')).toBe('Reference check');
    expect(milestoneLabel(null)).toBeNull();
    expect(milestoneLabel('')).toBeNull();
  });

  it('splits an archive by reason type in a fixed order, with shares of the stage', () => {
    expect(reasonTypeRows({ rejected_by_org: 70, rejected_by_candidate: 15, other: 4, none: 6 }, 95)).toEqual([
      { type: 'rejected_by_org', label: 'Rejected by us', count: '70', share: '74%' },
      { type: 'rejected_by_candidate', label: 'Withdrew', count: '15', share: '16%' },
      { type: 'other', label: 'Other', count: '4', share: '4.2%' },
      { type: 'none', label: 'No reason recorded', count: '6', share: '6.3%' },
    ]);
  });

  it('prints a reason type the response left out as a dash', () => {
    expect(reasonTypeRows({ rejected_by_org: 3 }, 3)[1]).toEqual({
      type: 'rejected_by_candidate',
      label: 'Withdrew',
      count: DASH,
      share: DASH,
    });
  });
});
