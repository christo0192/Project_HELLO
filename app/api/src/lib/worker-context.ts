/**
 * Server-side worker context resolution.
 *
 * Worker context comes from authenticated server-side Supabase/persistence lookup
 * using strict session/room UUID binding — never from client-visible metadata.
 *
 * The worker (agent.py) receives only opaque identifiers (session_id, room_name)
 * and resolves context server-side via the API.
 */

import { supabase } from './supabase.js';

// ── Stable error codes ───────────────────────────────────────────────

export const ERR_SESSION_NOT_FOUND = 'ERR_SESSION_NOT_FOUND';
export const ERR_SESSION_NOT_ACTIVE = 'ERR_SESSION_NOT_ACTIVE';
export const ERR_BINDING_MISMATCH = 'ERR_BINDING_MISMATCH';
export const ERR_DB_FAILED = 'ERR_DB_FAILED';

// ── Types ────────────────────────────────────────────────────────────

export interface WorkerContext {
  session_id: string;
  candidate_id: string;
  role_id: string | null;
  candidate_name: string | null;
  room_name: string;
  status: string;
}

export interface WorkerContextResultOk {
  ok: true;
  context: WorkerContext;
}

export interface WorkerContextResultErr {
  ok: false;
  code: string;
}

export type WorkerContextResult = WorkerContextResultOk | WorkerContextResultErr;

/**
 * Resolve worker context from a session_id and room_name.
 *
 * Validates:
 * - Session exists
 * - Room name (external_call_id) matches
 * - Session is in a valid active state (waiting, in_progress)
 *
 * Returns only the fields the worker needs — no resume facts, name/email/phone,
 * screening template, role JD, or scoring context.
 */
export async function resolveWorkerContext(
  sessionId: string,
  roomName: string,
): Promise<WorkerContextResult> {
  const { data, error } = await supabase
    .from('call_sessions')
    .select('id, candidate_id, role_id, status, external_call_id')
    .eq('id', sessionId)
    .single();

  if (error || !data) {
    return { ok: false, code: ERR_SESSION_NOT_FOUND };
  }

  // Verify room binding
  if (data.external_call_id !== roomName) {
    return { ok: false, code: ERR_BINDING_MISMATCH };
  }

  // Only allow active states
  const activeStates = new Set(['waiting', 'in_progress']);
  if (!activeStates.has(data.status as string)) {
    return { ok: false, code: ERR_SESSION_NOT_ACTIVE };
  }

  // Resolve candidate name (minimal — no resume facts/email/phone)
  const { data: candidate } = await supabase
    .from('candidates')
    .select('name')
    .eq('id', data.candidate_id)
    .single();

  return {
    ok: true,
    context: {
      session_id: data.id as string,
      candidate_id: data.candidate_id as string,
      role_id: data.role_id as string | null,
      candidate_name: candidate?.name as string | null ?? null,
      room_name: roomName,
      status: data.status as string,
    },
  };
}
