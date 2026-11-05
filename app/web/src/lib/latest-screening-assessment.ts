import type { Assessment, Session } from '../types';

/** The R1 scorer stamps `raw.r1` on every row it writes, placeholders included. */
function hasR1Stamp(assessment: Assessment): boolean {
  return (assessment.raw as { r1?: unknown } | null | undefined)?.r1 != null;
}

/**
 * The newest assessment that is a phone screening. `assessments` arrives
 * newest first. Rows whose session is an R1 round are skipped, and so is a row
 * stamped by the R1 scorer when this page has no session for it (the sessions
 * read can fail on its own); any other row with no session link, or one this
 * page has no session for, is kept.
 */
export function latestScreeningAssessment(
  assessments: readonly Assessment[],
  sessions: readonly Session[],
): Assessment | null {
  const r1 = new Set(
    sessions.filter((s) => s.interview_round_id != null).map((s) => s.id),
  );
  return (
    assessments.find((a) => !hasR1Stamp(a) && (!a.session_id || !r1.has(a.session_id))) ?? null
  );
}
