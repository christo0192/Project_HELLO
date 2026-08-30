/**
 * Durable handler for phone assessment scoring.
 *
 * The voice worker must not hold a PSTN leg open while Gemini scoring runs.
 * The session completion is already durable before this handler is queued;
 * this worker only scores/adopts that session and posts the existing audited
 * assessment.completed event. The queue dedup key is session-scoped.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QueueJob } from '../queue/types.js';
import type { QueueHandler } from '../queue/runner.js';
import { runAssessment, type RunAssessmentOptions } from '../../services/assessment.js';
import { PHONE_ASSESSMENT_QUEUE, phoneAssessmentDedupKey } from './config.js';

export { PHONE_ASSESSMENT_QUEUE, phoneAssessmentDedupKey };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadSessionId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>).session_id;
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function payloadAttemptId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>).attempt_id;
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

/**
 * 0072: the partial-finalize tick enqueues jobs carrying `partial:true` plus the
 * coverage/reason detail. A clean-hangup job (phone-worker.ts) carries none of
 * these, so absence means a COMPLETE screening. Read defensively — a malformed
 * field degrades to the complete-screening shape, never throws.
 */
interface PhonePartialFields {
  readonly partial: boolean;
  readonly covered: number | null;
  readonly total: number | null;
  readonly disconnectReason: string | undefined;
}

function payloadPartial(payload: unknown): PhonePartialFields {
  const p = (payload && typeof payload === 'object')
    ? (payload as Record<string, unknown>)
    : {};
  const covered = typeof p.covered === 'number' && Number.isFinite(p.covered) ? p.covered : null;
  const total = typeof p.total === 'number' && Number.isFinite(p.total) ? p.total : null;
  const reason = typeof p.disconnect_reason === 'string' ? p.disconnect_reason : undefined;
  return { partial: p.partial === true, covered, total, disconnectReason: reason };
}

export interface PhoneAssessmentHandlerOptions {
  client: SupabaseClient;
  score?: (sessionId: string, options?: RunAssessmentOptions) => Promise<unknown>;
}

export function createPhoneAssessmentHandler(
  options: PhoneAssessmentHandlerOptions,
): QueueHandler {
  const score = options.score
    ?? ((sessionId: string, runOptions?: RunAssessmentOptions) =>
      runAssessment(sessionId, runOptions ?? { source: 'phone' }));
  return async (job: QueueJob<unknown>): Promise<void> => {
    const sessionId = payloadSessionId(job.payload);
    const attemptId = payloadAttemptId(job.payload);
    if (!sessionId || !attemptId) throw new Error('malformed_phone_assessment_payload');

    // 0072: partial detail (if any) is forwarded into the scorer, which sets
    // `assessments.partial` and records coverage in `raw`. Scoring reads
    // `transcript_turns` regardless — a partial job scores exactly the turns
    // captured before the disconnect and never depends on the recording.
    const partial = payloadPartial(job.payload);

    // A scoring failure must fail the queue claim so the existing bounded retry
    // policy can retry it. No terminal event is posted until scoring succeeds.
    // The interlock is preserved: the assessment ROW is written HERE, before
    // any completion event is posted, so `apply_phone_event`'s 0044 existence
    // check always finds it.
    await score(sessionId, {
      source: 'phone',
      partial: partial.partial,
      covered: partial.covered,
      total: partial.total,
      disconnectReason: partial.disconnectReason,
    });

    // ── The completion post: an ATTEMPT post on the clean path, a STRANDED
    // ── post on the partial path. ──────────────────────────────────────────
    // On the CLEAN path (phone-worker.ts, no partial fields) the engagement is
    // still `in_call` — the worker only just finished — so the attempt-scoped
    // post matches 0067's `v_eng.state='in_call'` completion branch and ends
    // the attempt in the same edge.
    //
    // On the PARTIAL path (0072: hangup / network drop / worker crash) the
    // engagement is NO LONGER `in_call`: a disconnect already drove it to
    // `reconnecting`/`scheduled` (0067's in_call drop branch), or 0071's reclaim
    // restored it to `eligible`/`scheduled`/`reconnecting`. An attempt-scoped
    // `assessment.completed` matches NO branch from those states → the RPC
    // returns not-applied → this handler would throw → the job DLQs after 5
    // retries on the COMMON hangup path. So the partial path posts the STRANDED
    // shape instead (`p_attempt_id => null`, `p_engagement_id` resolved): 0067's
    // stranded branch drives the engagement cleanly to `completed` from exactly
    // those states when the bound session is terminal (which the sweep already
    // made it) and the 0044 interlock finds the row we just wrote. It sets NO
    // attempt edge — the attempt that carried the conversation ended long ago.
    const isPartial = partial.partial === true;
    let engagementId: string | null = null;
    if (isPartial) {
      engagementId = await resolveEngagementId(options.client, attemptId);
    }

    const { data, error } = await options.client.rpc('apply_phone_event', {
      p_source: 'internal',
      p_event_type: 'assessment.completed',
      // Partial → stranded (no attempt); clean → attempt-scoped.
      p_attempt_id: isPartial ? null : attemptId,
      p_engagement_id: isPartial ? engagementId : null,
      p_provider_event_id: `assessment:${sessionId}`,
      p_epoch: null,
      p_metadata: null,
      p_now: new Date().toISOString(),
    });
    if (error) throw new Error('phone_assessment_completion_event_failed');
    const status = (data as { status?: unknown } | null)?.status;
    if (status === 'applied' || status === 'duplicate') {
      return;
    }

    // Not applied. The scorecard has ALREADY landed (scoring above succeeded and
    // wrote the row), so a completion that could not apply must NEVER cost the
    // job its life on the retry treadmill — throwing here would burn retries and
    // eventually poison a job whose scorecard is already delivered, the exact
    // failure this repair removes. If a phone assessment row exists for the
    // session, succeed quietly: the engagement reconciliation is a durable,
    // separately-owned concern (0071's reclaim also re-drives a stranded
    // completion from the DB side), not this job's to guarantee. This file is
    // downstream of candidate data, so by package invariant it renders NOTHING
    // — the successful claim is recorded by the queue runner, a layer that is
    // permitted to observe it. Only when NO row exists — a genuinely anomalous
    // "not applied with nothing scored" — do we still throw so the bounded retry
    // can recover.
    const scored = await phoneAssessmentExists(options.client, sessionId);
    if (scored) {
      return;
    }
    throw new Error('phone_assessment_completion_not_applied');
  };
}

/**
 * Resolve the engagement id backing an attempt so the partial path can post the
 * STRANDED completion (`p_attempt_id => null`, engagement named). A lookup
 * failure or an unresolved attempt yields `null`; the RPC then finds no
 * engagement, returns not-applied, and the not-applied handling above decides
 * whether that is a benign already-scored no-op or a real anomaly to retry.
 */
async function resolveEngagementId(
  client: SupabaseClient,
  attemptId: string,
): Promise<string | null> {
  try {
    const { data, error } = await client
      .from('phone_call_attempts')
      .select('engagement_id')
      .eq('id', attemptId)
      .maybeSingle();
    if (error || !data) return null;
    const value = (data as { engagement_id?: unknown }).engagement_id;
    return typeof value === 'string' && UUID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * True when a `source='phone'` assessment row exists for the session. Used ONLY
 * to decide whether a not-applied completion is a benign already-scored no-op
 * (log, succeed) or a genuine anomaly (throw, retry). A lookup failure is
 * treated as "not known to be scored" so we fail safe toward the retry.
 */
async function phoneAssessmentExists(
  client: SupabaseClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const { data, error } = await client
      .from('assessments')
      .select('id')
      .eq('session_id', sessionId)
      .eq('source', 'phone')
      .maybeSingle();
    if (error) return false;
    return data != null;
  } catch {
    return false;
  }
}
