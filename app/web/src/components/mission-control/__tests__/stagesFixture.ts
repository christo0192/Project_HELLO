/**
 * The 18 stages every mapped Ashby job shares, as GET .../stage-catalog
 * answers them after a first refresh: plan order, Ashby's type, and the
 * default milestones the API sets (the Christy stage, R1 to R5, Reference
 * Check, Offer, Archived and Hired). Titles are the live ones
 * (.gsd/milestones/M031/BUSINESS-IMPACT-PLAN.md, "Live checks"); ids are
 * synthetic. No candidate data.
 */
import type { AshbyStageCatalogResponse, AshbyStageCatalogStage, AshbyStageMilestone } from '../../../lib/ashby-stages';

const LIVE: Array<[string, string, AshbyStageMilestone | null]> = [
  ['New Lead', 'Lead', null],
  ['Reached Out', 'Lead', null],
  ['Replied', 'Lead', null],
  ['Application Review', 'PreInterviewScreen', null],
  ['Hello Christy', 'PreInterviewScreen', 'christy'],
  ['TA Screen', 'PreInterviewScreen', null],
  ['HM Review', 'Active', null],
  ['R0 - Online Assessment', 'Active', null],
  ['R1', 'Active', 'r1'],
  ['R2', 'Active', 'r2'],
  ['R3', 'Active', 'r3'],
  ['R4', 'Active', 'r4'],
  ['R5', 'Active', 'r5'],
  ['Reference Check', 'Active', 'reference'],
  ['Document Submission', 'Active', null],
  ['Offer', 'Offer', 'offer'],
  ['Archived', 'Archived', 'archived'],
  ['Hired', 'Hired', 'hired'],
];

export function liveStages(): AshbyStageCatalogStage[] {
  return LIVE.map(([title, type, milestone], order) => ({
    id: `stage-${String(order + 1).padStart(2, '0')}`,
    title,
    type,
    order,
    milestone,
    milestoneSource: milestone ? 'default' : null,
    inPlan: true,
  }));
}

export function catalogResponse(overrides: Partial<AshbyStageCatalogResponse> = {}): AshbyStageCatalogResponse {
  return { ok: true, stages: liveStages(), enabledMappings: 3, unreadMappings: 0, truncated: false, ...overrides };
}
