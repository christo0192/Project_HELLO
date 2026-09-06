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
  /**
   * An allowlisted structured projection of parsed resume evidence for BOTH
   * screening lanes: phone rooms (phone-<uuid>) and browser rooms
   * (screening-<uuid>) receive the identical bounded payload so the shared
   * RESUME CHECK prompt directive can activate in either lane (owner-approved
   * 2026-09-07). Raw resume text and contact fields never cross.
   */
  candidate_evidence: Record<string, unknown>;
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

const PHONE_ROOM_RE = /^phone-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Browser/WebRTC rooms are named by roomNameForSession() in room-provisioning.ts
// (`screening-<sessionId>`); mirror the phone regex's strict UUID shape.
const BROWSER_ROOM_RE = /^screening-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Return only the structured resume fields the screening prompt is allowed to
 * see. Both lanes — phone (`phone-<uuid>`) and browser (`screening-<uuid>`) —
 * receive the SAME bounded allowlist, so the shared RESUME CHECK directive can
 * activate in the browser lane too (owner-approved 2026-09-07). Any other room
 * name yields an empty object.
 *
 * The agent must be constructed with its complete prompt before its first
 * generation; returning raw `candidates.parsed` would solve that timing
 * problem by creating a much larger privacy problem. Keep the allowlist next
 * to the authenticated worker-context boundary instead.
 */
function screeningCandidateEvidence(parsed: unknown, roomName: string): Record<string, unknown> {
  const allowedRoom = PHONE_ROOM_RE.test(roomName) || BROWSER_ROOM_RE.test(roomName);
  if (!allowedRoom || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const source = parsed as Record<string, unknown>;
  const evidence: Record<string, unknown> = {};
  for (const key of ['name', 'current_role', 'experience_years']) {
    const value = source[key];
    if (typeof value === 'string') evidence[key] = value.slice(0, 300);
    else if (typeof value === 'number' && Number.isFinite(value)) evidence[key] = value;
  }
  if (typeof source.summary === 'string') evidence.summary = source.summary.slice(0, 500);
  if (Array.isArray(source.skills)) {
    evidence.skills = source.skills.filter((v): v is string => typeof v === 'string').slice(0, 12);
  }
  const projectRole = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const role = value as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const key of ['title', 'employer', 'period']) {
      if (typeof role[key] === 'string') projected[key] = role[key].slice(0, 300);
    }
    if (Array.isArray(role.highlights)) {
      projected.highlights = role.highlights
        .filter((v): v is string => typeof v === 'string')
        .slice(0, 2)
        .map((v) => v.slice(0, 500));
    }
    return projected;
  };
  const recentRole = projectRole(source.recent_role);
  if (recentRole) evidence.recent_role = recentRole;
  if (Array.isArray(source.prior_roles)) {
    evidence.prior_roles = source.prior_roles.slice(0, 2).map(projectRole).filter(Boolean);
  }
  if (Array.isArray(source.career_highlights)) {
    evidence.career_highlights = source.career_highlights
      .filter((v): v is string => typeof v === 'string')
      .slice(0, 3)
      .map((v) => v.slice(0, 500));
  }
  return evidence;
}

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

  // Resolve name plus parsed structure. `screeningCandidateEvidence` immediately
  // projects the bounded allowlist; raw/contact fields never cross the API.
  const { data: candidate } = await supabase
    .from('candidates')
    .select('name,parsed')
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
      candidate_evidence: screeningCandidateEvidence(candidate?.parsed, roomName),
    },
  };
}
