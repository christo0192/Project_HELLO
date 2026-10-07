import type { Assessment, Session } from '../types';

/**
 * The newest assessment that is a phone screening. `assessments` arrives
 * newest first. Rows whose session is an R1 round are skipped; a row with no
 * session link, or one this page has no session for, is kept.
 */
export function latestScreeningAssessment(
  assessments: readonly Assessment[],
  sessions: readonly Session[],
): Assessment | null {
  const r1 = new Set(
    sessions.filter((s) => s.interview_round_id != null).map((s) => s.id),
  );
  return assessments.find((a) => !a.session_id || !r1.has(a.session_id)) ?? null;
}
