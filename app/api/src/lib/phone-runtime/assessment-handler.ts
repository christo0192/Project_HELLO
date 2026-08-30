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
    await score(sessionId, {
      source: 'phone',
      partial: partial.partial,
      covered: partial.covered,
      total: partial.total,
      disconnectReason: partial.disconnectReason,
    });

    const { data, error } = await options.client.rpc('apply_phone_event', {
      p_source: 'internal',
      p_event_type: 'assessment.completed',
      p_attempt_id: attemptId,
      p_engagement_id: null,
      p_provider_event_id: `assessment:${sessionId}`,
      p_epoch: null,
      p_metadata: null,
      p_now: new Date().toISOString(),
    });
    if (error) throw new Error('phone_assessment_completion_event_failed');
    const status = (data as { status?: unknown } | null)?.status;
    if (status !== 'applied' && status !== 'duplicate') {
      throw new Error('phone_assessment_completion_not_applied');
    }
  };
}
