/**
 * C3 (migration 0114): pure helpers for the interview-evidence hold. Kept out
 * of the component module so it exports components only (fast refresh).
 */

import type { Assessment } from '../types';

/** True when this assessment row is graded `insufficient` (C3). */
export function isEvidenceInsufficient(assessment: unknown): boolean {
  return (
    assessment !== null
    && typeof assessment === 'object'
    && (assessment as { evidence_grade?: unknown }).evidence_grade === 'insufficient'
  );
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** Why the evidence is insufficient, in recruiter language. Never PII. */
export function evidenceHoldReason(assessment: Pick<Assessment, 'evidence_reason' | 'evidence_answered' | 'evidence_planned'>): string {
  const answered = count(assessment.evidence_answered);
  const planned = count(assessment.evidence_planned);
  switch (assessment.evidence_reason) {
    case 'infra_interrupted':
      return 'The call was cut off on our side before enough of the interview happened.';
    case 'no_candidate_speech':
      return 'The candidate did not answer any screening question.';
    case 'partial_thin':
      return answered !== null && planned !== null
        ? `The call ended after ${answered} of ${planned} planned questions were answered.`
        : 'The call ended before enough of the planned questions were answered.';
    default:
      return 'How much of the interview took place could not be confirmed.';
  }
}
