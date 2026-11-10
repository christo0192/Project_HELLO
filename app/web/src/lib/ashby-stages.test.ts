/**
 * The Stages section's words (M031 S2): milestone labels and picker keys,
 * stage types and positions, and the sentences for a refresh and a label.
 * Never a raw code on the page.
 */
import { describe, expect, it } from 'vitest';
import {
  MILESTONE_OPTIONS,
  NOT_LABELLED,
  STAGE_MILESTONES,
  isStageMilestone,
  labelSavedText,
  milestoneFromKey,
  milestoneKey,
  milestoneLabel,
  milestoneSourceLabel,
  refreshNotice,
  stagePosition,
  stageTitle,
  stageTypeLabel,
  type AshbyStageCatalogRefresh,
  type AshbyStageCatalogStage,
} from './ashby-stages';

const REFRESH: AshbyStageCatalogRefresh = {
  mappings: { enabled: 3, truncated: false },
  jobs: { attempted: 3, read: 3, failed: 0, notTried: 0 },
  failures: [],
  stages: { seen: 18, inserted: 18, updated: 0, defaulted: 10, redefaulted: 0, leftPlan: 0 },
  deadlineHit: false,
};

const stage = (over: Partial<AshbyStageCatalogStage> = {}): AshbyStageCatalogStage => ({
  id: 'stage-x', title: 'HM Review', type: 'Active', order: 6, milestone: null, milestoneSource: null, inPlan: true, ...over,
});

describe('the milestone vocabulary', () => {
  it("is the API's allowed set, in its order", () => {
    expect([...STAGE_MILESTONES]).toEqual(['christy', 'r1', 'r2', 'r3', 'r4', 'r5', 'reference', 'offer', 'hired', 'archived', 'other']);
  });

  it('the picker offers Not labelled first, then every milestone once', () => {
    expect(MILESTONE_OPTIONS.map((o) => o.value)).toEqual([NOT_LABELLED, ...STAGE_MILESTONES]);
    expect(MILESTONE_OPTIONS.map((o) => o.label)).toEqual([
      'Not labelled', 'Christy stage', 'R1', 'R2', 'R3', 'R4', 'R5', 'Reference check', 'Offer', 'Hired', 'Archived', 'Other',
    ]);
  });

  it('round-trips a picker key, and "none" is null', () => {
    for (const m of STAGE_MILESTONES) expect(milestoneFromKey(milestoneKey(m))).toBe(m);
    expect(milestoneKey(null)).toBe(NOT_LABELLED);
    expect(milestoneFromKey(NOT_LABELLED)).toBeNull();
    expect(milestoneFromKey('R1')).toBeNull();
    expect(isStageMilestone('toString')).toBe(false);
  });

  it('names a milestone and its setter in words', () => {
    expect(milestoneLabel('reference')).toBe('Reference check');
    expect(milestoneLabel(null)).toBe('Not labelled');
    expect(milestoneSourceLabel('admin')).toBe('Admin');
    expect(milestoneSourceLabel('default')).toBe('Default');
    expect(milestoneSourceLabel(null)).toBe('—');
  });
});

describe('a stage in words', () => {
  it.each([
    ['PreInterviewScreen', 'Pre-interview screen'], ['Active', 'Active'], ['Lead', 'Lead'], ['Offer', 'Offer'],
    ['Archived', 'Archived'], ['Hired', 'Hired'], ['SomethingNew', 'SomethingNew'], [null, '—'], ['constructor', 'constructor'],
  ])('type %j reads %j', (type, label) => expect(stageTypeLabel(type)).toBe(label));

  it('prints a 1-based position, or a dash', () => {
    expect(stagePosition(0)).toBe('1');
    expect(stagePosition(17)).toBe('18');
    expect(stagePosition(null)).toBe('—');
    expect(stagePosition(-1)).toBe('—');
  });

  it('a stage with no title is an untitled stage', () => {
    expect(stageTitle({ title: null })).toBe('Untitled stage');
    expect(stageTitle({ title: '  ' })).toBe('Untitled stage');
    expect(stageTitle({ title: 'R1' })).toBe('R1');
  });
});

describe('what a refresh did', () => {
  it('a clean first refresh', () => {
    expect(refreshNotice(REFRESH)).toEqual({
      tone: 'success',
      text: 'Read 3 jobs from Ashby: 18 stages, 18 new stages, 10 labelled by default.',
    });
  });

  it('a repeat refresh adds nothing', () => {
    expect(refreshNotice({ ...REFRESH, stages: { seen: 18, inserted: 0, updated: 18, defaulted: 0, redefaulted: 0, leftPlan: 0 } }).text)
      .toBe('Read 3 jobs from Ashby: 18 stages, no new stage.');
  });

  it('a default label that moved with a renamed or retyped stage is counted apart (S2-2)', () => {
    expect(refreshNotice({ ...REFRESH, stages: { seen: 19, inserted: 1, updated: 18, defaulted: 1, redefaulted: 2, leftPlan: 0 } }).text)
      .toBe('Read 3 jobs from Ashby: 19 stages, 1 new stage, 1 labelled by default, 2 default labels changed.');
    expect(refreshNotice({ ...REFRESH, stages: { seen: 18, inserted: 0, updated: 18, defaulted: 0, redefaulted: 1, leftPlan: 0 } }).text)
      .toBe('Read 3 jobs from Ashby: 18 stages, no new stage, 1 default label changed.');
  });

  it('a stage Ashby removed from the plan is counted, never as deleted (S2-4)', () => {
    expect(refreshNotice({ ...REFRESH, stages: { seen: 18, inserted: 1, updated: 17, defaulted: 0, redefaulted: 0, leftPlan: 1 } }).text)
      .toBe('Read 3 jobs from Ashby: 18 stages, 1 new stage, 1 stage no longer in the plan.');
    expect(refreshNotice({ ...REFRESH, stages: { seen: 16, inserted: 0, updated: 16, defaulted: 0, redefaulted: 0, leftPlan: 2 } }).text)
      .toBe('Read 3 jobs from Ashby: 16 stages, no new stage, 2 stages no longer in the plan.');
  });

  it('a partial failure is a warning that names the cause in words', () => {
    const n = refreshNotice({
      ...REFRESH,
      jobs: { attempted: 3, read: 2, failed: 1, notTried: 0 },
      failures: [{ code: 'missing_permission', count: 1 }],
    });
    expect(n.tone).toBe('warning');
    expect(n.text).toContain("Ashby didn't return the stages for 1 of 3 jobs: HELLO's Ashby key is missing the Jobs read permission.");
    expect(n.text).not.toMatch(/_/);
  });

  it('a total failure is a fault', () => {
    const n = refreshNotice({
      ...REFRESH,
      jobs: { attempted: 3, read: 0, failed: 3, notTried: 0 },
      failures: [{ code: 'forbidden', count: 3 }],
      stages: { seen: 0, inserted: 0, updated: 0, defaulted: 0, redefaulted: 0, leftPlan: 0 },
    });
    expect(n).toEqual({ tone: 'danger', text: "Ashby didn't return the stages for 3 of 3 jobs: Ashby refused HELLO's key." });
  });

  it('an unknown code still reads as words', () => {
    const n = refreshNotice({ ...REFRESH, jobs: { attempted: 1, read: 0, failed: 1, notTried: 0 }, failures: [{ code: 'output_limit', count: 1 }] });
    expect(n.text).toBe("Ashby didn't return the stages for 1 of 1 job: Ashby returned an error.");
  });

  it('jobs the deadline left are asked to be refreshed again', () => {
    const n = refreshNotice({ ...REFRESH, jobs: { attempted: 2, read: 2, failed: 0, notTried: 1 }, deadlineHit: true });
    expect(n.tone).toBe('warning');
    expect(n.text).toContain('1 job was not read before time ran out. Refresh again.');
  });

  it('no live mapping is a plain note', () => {
    expect(refreshNotice({ ...REFRESH, mappings: { enabled: 0, truncated: false }, jobs: { attempted: 0, read: 0, failed: 0, notTried: 0 } }))
      .toEqual({ tone: 'info', text: 'There is no live job mapping, so there was no interview plan to read.' });
  });
});

describe('what a label change did', () => {
  it('a label', () => {
    expect(labelSavedText(stage(), stage({ milestone: 'other', milestoneSource: 'admin' }), false)).toBe('HM Review now counts as Other.');
  });

  it('a clear that returns to a default', () => {
    expect(labelSavedText(stage({ title: 'Offer', milestone: 'other' }), stage({ title: 'Offer', milestone: 'offer', milestoneSource: 'default' }), true))
      .toBe("Offer's label is cleared. It counts as Offer by default.");
  });

  it('a clear with no default', () => {
    expect(labelSavedText(stage({ milestone: 'r1' }), stage(), true)).toBe("HM Review's label is cleared. It is not labelled, so it counts as Other.");
    expect(labelSavedText(stage(), stage(), true)).toBe('HM Review is not labelled, so it counts as Other.');
  });
});
