/**
 * The Business impact sections' rules that are not components (M031 S6): kept
 * apart so each component file exports components only.
 */
import type { ImpactPipelineStep, ImpactStepKey } from '../../lib/impact';

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The pipeline cells the contract leaves null because they do not apply to the
 * step, not because they are not known: Came in has no step before it; nobody
 * is still at "A person decided in Ashby", since deciding is leaving the Christy
 * stage; and Hired is the end, so nothing is still at it or drops from it.
 */
const NOT_APPLICABLE = {
  ofPrevious: new Set<ImpactStepKey>(['came_in']),
  stillHere: new Set<ImpactStepKey>(['decided', 'hired']),
  droppedHere: new Set<ImpactStepKey>(['hired']),
} as const;

/** The cell has no figure because it does not apply. A figure the API sends there anyway is printed. */
export function doesNotApply(column: keyof typeof NOT_APPLICABLE, step: ImpactStepKey, value: unknown): boolean {
  return !known(value) && NOT_APPLICABLE[column].has(step);
}

/**
 * The two shares of each step, with any that cannot be true taken out: a step
 * counting more than the one before it, or more than came in, has no share.
 */
export function nestedShares(pipeline: ReadonlyArray<ImpactPipelineStep>): Array<{ ofPrevious: number | null; ofCameIn: number | null }> {
  const cameIn = pipeline[0]?.reached;
  return pipeline.map((row, index) => {
    const previous = index > 0 ? pipeline[index - 1]?.reached : null;
    const overPrevious = known(row.reached) && known(previous) && row.reached > previous;
    const overCameIn = known(row.reached) && known(cameIn) && row.reached > cameIn;
    return {
      ofPrevious: overPrevious ? null : row.ofPrevious,
      ofCameIn: overCameIn ? null : row.ofCameIn,
    };
  });
}

/** The contract's default page. */
export const IMPACT_LIST_PAGE_SIZE = 50;

/**
 * An Ashby application status in the family it means: underway is `moving`,
 * hired is a good result, archived has ended with no judgement. Lead and anything
 * else stays ink. The word is always printed.
 */
const STATUS_CLASS: Readonly<Record<string, string>> = {
  active: 'text-moving-text',
  hired: 'text-ready-text',
  archived: 'text-closed-text',
};

export function applicationStatusClass(status: string | null | undefined): string {
  return (status && STATUS_CLASS[status.trim().toLowerCase()]) || 'text-ink';
}

export function impactDefinitions(minTimingN: number): Array<[string, string]> {
  return [
    [
      'Applications',
      'One row per Ashby application HELLO imported. The same person on two jobs is two applications. A candidate a recruiter uploaded by hand has no Ashby application and is not counted, and nor is a job an admin has left out of this page.',
    ],
    [
      'Weeks',
      'An application is counted in the IST week it entered the Christy stage, and weeks start on Monday. Choosing other weeks changes which applications are included, not how they are measured.',
    ],
    [
      'Steps nest',
      'Each step counts only the applications that also reached the step before it, so no share is over 100%. Of previous is a step’s share of the step above it; of came in is its share of every application that came in. A share that would be over 100% is a fault, and shows a dash.',
    ],
    ['Came in', 'The application entered the Christy stage in Ashby.'],
    [
      'Christy called',
      'Christy placed at least one call. On a job screened in the browser instead of by phone, this is the browser session starting.',
    ],
    [
      'Christy connected',
      'The candidate gave consent, so a real conversation began. Call answered, underneath, counts calls that were picked up, which can include voicemail. In the browser, it is consent given there.',
    ],
    [
      'Scored',
      'Christy gave a Select, Borderline or Reject, a provisional one included. Held (thin evidence) and No verdict are rows in the verdict table only. The verdict is the newest one on this application’s own calls, never one from the same person’s other applications.',
    ],
    ['A person decided in Ashby', 'The application left the Christy stage: it was moved forward, or archived from it.'],
    [
      'Moved forward in Ashby',
      'The application reached a stage after the Christy stage in the job’s plan that is not an Archived or a Lead stage.',
    ],
    [
      'R1, R2 or Offer or later',
      'The application reached the stage labelled R1, R2 or Offer, or any later labelled stage. Archived and Lead stages never count as reaching a stage, so an archived application is not counted as having reached Offer.',
    ],
    ['Hired', 'The application is hired in Ashby.'],
    [
      'Still here and Dropped here',
      'Still here counts applications that reached a step and are still at it. Dropped here counts the ones that stopped at that step and will not go further. Nobody is still at A person decided in Ashby, because deciding is leaving the Christy stage, and Hired is the end. A cell that does not apply, like these and Came in’s of previous, is a paler dash, and a screen reader says it does not apply.',
    ],
    [
      'Christy’s verdict against what happened next',
      'Each verdict’s applications by what happened in Ashby, as counts and shares of the row. Still active counts the ones Ashby still has open, at any stage.',
    ],
    [
      'Where candidates leave',
      'Archived applications by the stage they were archived at, split by the reason type Ashby recorded. Ashby allows an archive with no reason. The top reasons are Ashby’s own reason list, at most five a stage, never free text.',
    ],
    [
      'Time between steps',
      `The median and the 90th percentile in days, over completed steps only, with n the number of applications that completed the step. With fewer than ${minTimingN}, the times are not shown.`,
    ],
    [
      'Weekly cohorts and By job',
      'The share of each week’s, or each job’s, applications that reached each step. A young week has not had time to reach the later steps, so it is marked still maturing: do not compare it with older weeks as if it were finished.',
    ],
    [
      'Ashby stages',
      'HELLO reads each application’s stage from Ashby, and the line at the top says when it last checked. While they are not being read, every step from A person decided in Ashby onward shows a dash, never a 0.',
    ],
  ];
}
