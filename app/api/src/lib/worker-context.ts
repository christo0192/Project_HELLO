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
  role_title: string | null;
  role_focus: string | null;
  role_required_skills: string[];
  screening_template: unknown[];
  interviewer_instructions: string;
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
 * Returns only server-verified interview context. It excludes candidate email,
 * phone and raw resume text while carrying role-scoped prompt guidance.
 */
export async function resolveWorkerContext(
  sessionId: string,
  roomName: string,
): Promise<WorkerContextResult> {
  const { data, error } = await supabase
    .from('call_sessions')
    .select('id, candidate_id, role_id, status, external_call_id')
    .eq('id', sessionId)
    .maybeSingle();

  // Distinguish a transient DB failure from a genuinely-absent session.
  // `.maybeSingle()` returns data:null WITHOUT an error when there is no row,
  // and populates `error` only on an actual query/connection failure. Conflating
  // the two (the previous `error || !data → NOT_FOUND`) made a cold-start DB blip
  // look like "session not found" — a 404 the worker treats as a permanent
  // failure, so the bot never activated. A transient error must be retryable.
  if (error) {
    return { ok: false, code: ERR_DB_FAILED };
  }
  if (!data) {
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

  let role: any = null;
  if (data.role_id) {
    const result = await supabase
      .from('roles')
      .select('title,jd,required_skills,screening_template,interviewer_instructions')
      .eq('id', data.role_id)
      .maybeSingle();
    if (result.error) return { ok: false, code: ERR_DB_FAILED };
    role = result.data;
  }

  return {
    ok: true,
    context: {
      session_id: data.id as string,
      candidate_id: data.candidate_id as string,
      role_id: data.role_id as string | null,
      candidate_name: candidate?.name as string | null ?? null,
      room_name: roomName,
      status: data.status as string,
      role_title: role?.title as string | null ?? null,
      role_focus: role?.jd as string | null ?? null,
      role_required_skills: Array.isArray(role?.required_skills) ? role.required_skills : [],
      screening_template: Array.isArray(role?.screening_template) ? role.screening_template : [],
      interviewer_instructions: typeof role?.interviewer_instructions === 'string' ? role.interviewer_instructions : '',
    },
  };
}
