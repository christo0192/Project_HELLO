/**
 * CandidateScorecardV2 — the candidate page's Review-tab view of a
 * schema_version=2 (role-scorecard) assessment.
 *
 * Rendered by `TranscriptionSyncWorkspace` when the selected assessment is v2;
 * the legacy 1–10 `CandidateScorecard` is rendered unchanged for v1 rows.
 *
 * It is the SAME view the session and screening pages use
 * (`session/RoleScorecardBody`): the weighted overall and the recommendation
 * first, then one list of metrics separated by hairlines, each with its
 * rubric word, a pip reading, its weight, the model's rationale and the
 * evidence it quoted. One surface, no card per metric: the earlier version
 * stacked a sunken card for every metric inside a card, the "identical card
 * grid" the review flagged, and read differently from the session page.
 *
 * Every score is rendered on the assessment's OWN scale (`scoreScaleMax`): new
 * rows are 1–4 (Poor/Average/Good/Excellent, matching Ashby's four-point Score
 * fields); rows scored before the four-level rubric stay 1–5 with the legacy
 * labels and are never re-bucketed.
 */

import type { ScorecardAssessmentDisplay } from '../../types';
import { SurfaceCard } from '../design/candidate';
import { RoleScorecardBody } from '../session/RoleScorecardView';

export interface CandidateScorecardV2Props {
  scorecard: ScorecardAssessmentDisplay;
}

export function CandidateScorecardV2({ scorecard }: CandidateScorecardV2Props) {
  return (
    <SurfaceCard as="section" label="Overall assessment" className="p-4 sm:p-5">
      {/* No summary here: the Review tab shows the transcript beside it, and
          the candidate header already carries the verdict's context. */}
      <RoleScorecardBody scorecard={scorecard} />
    </SurfaceCard>
  );
}
