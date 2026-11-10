/**
 * The interview plan every mapped Ashby job shares, as read live on 2026-11-09
 * (.gsd/milestones/M031/BUSINESS-IMPACT-PLAN.md, "Live checks"): 18 stages, in
 * plan order, with the type each is expected to carry. The ids are synthetic;
 * the titles are the live ones. No candidate data.
 */
export const LIVE_STAGES: ReadonlyArray<{ id: string; title: string; type: string }> = [
  { id: 'stage-01-lead', title: 'New Lead', type: 'Lead' },
  { id: 'stage-02-reached', title: 'Reached Out', type: 'Lead' },
  { id: 'stage-03-replied', title: 'Replied', type: 'Lead' },
  { id: 'stage-04-review', title: 'Application Review', type: 'PreInterviewScreen' },
  { id: 'stage-05-christy', title: 'Hello Christy', type: 'PreInterviewScreen' },
  { id: 'stage-06-ta', title: 'TA Screen', type: 'PreInterviewScreen' },
  { id: 'stage-07-hm', title: 'HM Review', type: 'Active' },
  { id: 'stage-08-r0', title: 'R0 - Online Assessment', type: 'Active' },
  { id: 'stage-09-r1', title: 'R1', type: 'Active' },
  { id: 'stage-10-r2', title: 'R2', type: 'Active' },
  { id: 'stage-11-r3', title: 'R3', type: 'Active' },
  { id: 'stage-12-r4', title: 'R4', type: 'Active' },
  { id: 'stage-13-r5', title: 'R5', type: 'Active' },
  { id: 'stage-14-ref', title: 'Reference Check', type: 'Active' },
  { id: 'stage-15-docs', title: 'Document Submission', type: 'Active' },
  { id: 'stage-16-offer', title: 'Offer', type: 'Offer' },
  { id: 'stage-17-archived', title: 'Archived', type: 'Archived' },
  { id: 'stage-18-hired', title: 'Hired', type: 'Hired' },
];
