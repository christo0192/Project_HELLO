/**
 * attempt-consent-stage.ts — was a phone leg's audio captured before the
 * candidate consented to the recording?
 *
 * ONE classification, used by both places that state it:
 * - the attempt history (`GET /api/candidates/:id/phone-attempts`
 *   `consent_stage`), which drives the "Recorded before consent" tag, and
 * - the attempt recording mint (`GET /api/recordings/attempts/:id/download`),
 *   whose `recording.download` audit row carries `pre_consent`.
 * Two rules would let a compliance query over audit_events report a
 * pre-consent access the UI never claimed (or the reverse).
 */

/**
 * Attempt outcomes that by definition end before (or at) the recording
 * consent step. Used only to classify a leg whose parent session was later
 * completed by ANOTHER leg (0107 binds `session_id` at consent, so a completed
 * parent alone does not say whether this leg consented).
 */
export const PRE_CONSENT_ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set([
  'abandoned_pre_disclosure',
  'consent_failed',
  'declined',
  'voicemail',
]);

export type AttemptConsentStage = 'before_consent' | 'after_consent' | null;

/**
 * Whether a leg's audio was captured before the candidate consented.
 *
 * - `session_id` set: 0107 binds it at consent, so the leg consented.
 * - `session_id` NULL with a `recording_session_id`: the worker recorded the
 *   leg from the start (0105 policy) and consent was never bound to it. That
 *   is "before consent" when the outcome is a pre-consent one, or when the
 *   parent session never completed. A NULL-bound leg under a COMPLETED parent
 *   with any other outcome may be a pre-0107 leg that did consent, so it is
 *   reported as unknown (null) rather than mislabelled.
 * - `parentStatus` undefined means the parent could not be read: unknown.
 */
export function attemptConsentStage(
  row: {
    session_id: string | null | undefined;
    recording_session_id: string | null | undefined;
    outcome_class: string | null | undefined;
  },
  parentStatus: string | null | undefined,
): AttemptConsentStage {
  if (row.session_id) return 'after_consent';
  if (!row.recording_session_id || parentStatus === undefined) return null;
  if (row.outcome_class && PRE_CONSENT_ATTEMPT_OUTCOMES.has(row.outcome_class)) return 'before_consent';
  return parentStatus !== null && parentStatus !== 'completed' ? 'before_consent' : null;
}

/** The audit's `pre_consent`: true / false, or null when it cannot be told. */
export function preConsentFlag(stage: AttemptConsentStage): boolean | null {
  return stage === 'before_consent' ? true : stage === 'after_consent' ? false : null;
}
