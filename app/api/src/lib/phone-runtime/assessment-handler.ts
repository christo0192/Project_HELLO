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
import { runAssessment } from '../../services/assessment.js';
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

export interface PhoneAssessmentHandlerOptions {
  client: SupabaseClient;
  score?: (sessionId: string) => Promise<unknown>;
}

export function createPhoneAssessmentHandler(
  options: PhoneAssessmentHandlerOptions,
): QueueHandler {
  const score = options.score ?? ((sessionId: string) => runAssessment(sessionId, { source: 'phone' }));
  return async (job: QueueJob<unknown>): Promise<void> => {
    const sessionId = payloadSessionId(job.payload);
    const attemptId = payloadAttemptId(job.payload);
    if (!sessionId || !attemptId) throw new Error('malformed_phone_assessment_payload');

    // A scoring failure must fail the queue claim so the existing bounded retry
    // policy can retry it. No terminal event is posted until scoring succeeds.
    await score(sessionId);

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
