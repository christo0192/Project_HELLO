/**
 * attempt-consent-stage.ts — at what point of the consent flow was a phone
 * leg's audio captured, and what did the candidate do about consent on it?
 *
 * ONE classification, used by both places that state it:
 * - the attempt history (`GET /api/candidates/:id/phone-attempts`
 *   `consent_stage`), which drives the "Recorded before consent", "Consent
 *   withdrawn" and "Callback requested after consent" tags, and
 * - the attempt recording mint (`GET /api/recordings/attempts/:id/download`),
 *   whose `recording.download` audit row carries `pre_consent` (and
 *   `consent_withdrawn` / `deferred_after_consent` when true).
 * Two rules would let a compliance query over audit_events report an access
 * the UI never claimed (or the reverse). Both callers load the per-leg facts
 * with `loadLegConsentFacts`, so they read the same events the same way.
 *
 * M013 S02 (D8). Every recording is kept (owner decision); the stage only
 * says what the candidate did. The two post-consent stages are keyed ONLY on
 * facts about THIS leg — its own outcome or a ledger event naming its
 * attempt id — never on the engagement's state: an engagement that later
 * opted out on another leg must not flag an earlier, unrelated leg.
 */

import { supabase } from './supabase.js';

/**
 * Attempt outcomes that by definition end before (or at) the recording
 * consent step. Used only to classify a leg whose parent session was later
 * completed by ANOTHER leg (0107 binds `session_id` at consent, so a completed
 * parent alone does not say whether this leg consented). `opt_out` is the
 * outcome of a refused disclosure (0114 `disclosure.refused`); on a
 * consent-bound leg it is a withdrawal instead (below), because the
 * `session_id` check comes first.
 */
export const PRE_CONSENT_ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set([
  'abandoned_pre_disclosure',
  'consent_failed',
  'declined',
  'voicemail',
  'opt_out',
]);

/** The ledger events that name a consented leg's withdrawal or deferral. */
export const LEG_CONSENT_EVENT_TYPES = ['candidate.opt_out', 'callback.deferred_in_call'] as const;

/**
 * PostgREST `max_rows` (app/supabase/config.toml). A read returning this many
 * rows may be silently truncated, so it is reported as unknown.
 */
export const LEG_CONSENT_EVENT_ROW_CAP = 1000;

export type AttemptConsentStage =
  | 'before_consent'
  | 'after_consent'
  | 'consent_withdrawn'
  | 'deferred_after_consent'
  | null;

/** What THIS leg's own ledger events say about consent. */
export interface LegConsentFacts {
  /** A `candidate.opt_out` event names this attempt (incl. the 0114 C7-a lost race). */
  optOut: boolean;
  /** A `callback.deferred_in_call` event names this attempt. */
  deferredInCall: boolean;
}

export const NO_LEG_CONSENT_FACTS: LegConsentFacts = Object.freeze({ optOut: false, deferredInCall: false });

/**
 * Whether a leg's audio was captured before the candidate consented, and on
 * a consented leg whether the candidate then withdrew or deferred.
 *
 * - `session_id` set: 0107 binds it at consent, so the leg consented. Then:
 *   - `consent_withdrawn` when the leg ended `opt_out` or a `candidate.opt_out`
 *     event names it (the C7-a post that lost the race to the drop keeps the
 *     outcome `disconnected` but names the attempt);
 *   - `deferred_after_consent` when it ended `callback_deferred` or a
 *     `callback.deferred_in_call` event names it — a busy "call me later" is
 *     a deferral, not a withdrawal of consent;
 *   - otherwise `after_consent`, but only when the leg's events were read
 *     (`legFacts` non-null). Unread facts make it unknown (null) rather than
 *     a confident "nothing happened".
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
  legFacts: LegConsentFacts | null,
): AttemptConsentStage {
  if (row.session_id) {
    if (row.outcome_class === 'opt_out' || legFacts?.optOut) return 'consent_withdrawn';
    if (row.outcome_class === 'callback_deferred' || legFacts?.deferredInCall) return 'deferred_after_consent';
    return legFacts ? 'after_consent' : null;
  }
  if (!row.recording_session_id || parentStatus === undefined) return null;
  if (row.outcome_class && PRE_CONSENT_ATTEMPT_OUTCOMES.has(row.outcome_class)) return 'before_consent';
  return parentStatus !== null && parentStatus !== 'completed' ? 'before_consent' : null;
}

/**
 * The audit's `pre_consent`: true / false, or null when it cannot be told.
 * Both post-consent stages are `false`: the leg did consent.
 */
export function preConsentFlag(stage: AttemptConsentStage): boolean | null {
  if (stage === 'before_consent') return true;
  if (stage === 'after_consent' || stage === 'consent_withdrawn' || stage === 'deferred_after_consent') return false;
  return null;
}

/**
 * Load the per-leg consent facts for a set of attempts in ONE query (the
 * history page batches every consent-bound leg it shows; the download route
 * passes one id). Every id asked for gets an entry. Returns null when the read
 * failed or may be truncated: the caller then reports the stage as unknown or
 * fails, never "nothing happened". Reads event type and attempt id only.
 */
export async function loadLegConsentFacts(
  attemptIds: readonly string[],
): Promise<Map<string, LegConsentFacts> | null> {
  const facts = new Map<string, LegConsentFacts>();
  const ids = [...new Set(attemptIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return facts;
  try {
    const { data, error } = await supabase
      .from('phone_call_events')
      .select('attempt_id,event_type')
      .in('attempt_id', ids)
      .in('event_type', [...LEG_CONSENT_EVENT_TYPES])
      .limit(LEG_CONSENT_EVENT_ROW_CAP);
    if (error) return null;
    const rows = Array.isArray(data) ? data as Array<{ attempt_id?: unknown; event_type?: unknown }> : [];
    if (rows.length >= LEG_CONSENT_EVENT_ROW_CAP) return null;
    for (const id of ids) facts.set(id, { optOut: false, deferredInCall: false });
    for (const row of rows) {
      if (typeof row.attempt_id !== 'string') continue;
      const entry = facts.get(row.attempt_id);
      if (!entry) continue;
      if (row.event_type === 'candidate.opt_out') entry.optOut = true;
      else if (row.event_type === 'callback.deferred_in_call') entry.deferredInCall = true;
    }
    return facts;
  } catch {
    return null;
  }
}
