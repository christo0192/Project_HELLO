/**
 * Phase 9 L3 — append-only recruiter notes + candidate status transitions.
 *
 * Invariant 2:
 * - recruiter_notes is append-only (UPDATE/direct DELETE blocked by the
 *   0015 trigger; only INSERT is possible through this API).
 * - Note body is bounded (1..2000 chars, matching the DB CHECK).
 * - Interviewer ownership / admin access; viewer read-only.
 * - Candidate status transitions use an explicit allowlist + CAS, write an
 *   audit row (candidate_status_changed), and fail closed while
 *   candidates.decision_use_blocked_at is set. Evidence/assessment fields
 *   are never touched and unknown statuses are never accepted.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole, requireInterviewer } from '../lib/rbac.js';
import { validateBody, validateQuery, validateParams } from '../lib/validation.js';
import {
  noteCreateSchema,
  noteListQuerySchema,
  candidateStatusUpdateSchema,
  candidateIdParamSchema,
  CANDIDATE_STATUS_TRANSITIONS,
  type CandidateStatus,
  type NoteListResponse,
  type NoteResponse,
  type StatusTransitionResponse,
} from '../schemas/notes.js';

export const notesRouter = Router();

function forbiddenBody(): { error: { type: string; message: string } } {
  return { error: { type: 'authorization_error', message: 'Insufficient permissions' } };
}

/**
 * Ownership/existence scope: candidates exist for admin/viewer; interviewers
 * must own the candidate (matches routes/candidates.ts semantics).
 */
async function assertCandidateAccess(
  candidateId: string,
  user: { id: string; appRole: string },
): Promise<'ok' | 'not_found' | 'forbidden'> {
  const { data } = await supabase
    .from('candidates')
    .select('owner_id')
    .eq('id', candidateId)
    .maybeSingle();
  if (!data) return 'not_found';
  if (user.appRole === 'interviewer' && data.owner_id !== user.id) return 'forbidden';
  return 'ok';
}

/** GET /api/notes?candidate_id=&limit= — viewer read only, ownership-scoped. */
notesRouter.get(
  '/',
  requireRole('viewer'),
  validateQuery(noteListQuerySchema),
  async (req, res, next) => {
    try {
      const candidateId = req.query.candidate_id as string;
      const scope = await assertCandidateAccess(candidateId, req.authUser!);
      if (scope === 'not_found') return res.status(404).json({ error: 'candidate_not_found' });
      if (scope === 'forbidden') return res.status(403).json(forbiddenBody());

      const limit = Number(req.query.limit ?? 100);
      const { data, error } = await supabase
        .from('recruiter_notes')
        .select('id, candidate_id, author_id, note, created_at')
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (error) return next(new Error('failed to list notes'));

      const body: NoteListResponse = { notes: (data ?? []) as NoteResponse[] };
      res.json(body);
    } catch (error) {
      next(error);
    }
  },
);

/** POST /api/notes — append-only note (interviewer+/admin, ownership). */
notesRouter.post(
  '/',
  requireInterviewer,
  validateBody(noteCreateSchema),
  async (req, res, next) => {
    try {
      const { candidate_id, note } = req.body;
      const scope = await assertCandidateAccess(candidate_id, req.authUser!);
      if (scope === 'not_found') return res.status(404).json({ error: 'candidate_not_found' });
      if (scope === 'forbidden') return res.status(403).json(forbiddenBody());

      const { data: record, error } = await supabase
        .from('recruiter_notes')
        .insert({ candidate_id, author_id: req.authUser!.id, note })
        .select('id, candidate_id, author_id, note, created_at')
        .single();
      if (error || !record) return next(new Error('failed to add note'));

      res.status(201).json(record as NoteResponse);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/notes/:candidateId/status — allowlisted CAS transition.
 * Fails closed while decision_use_blocked_at is set; concurrent changes
 * (CAS miss) → 409; audit row (candidate_status_changed) on success.
 */
notesRouter.post(
  '/:candidateId/status',
  requireInterviewer,
  validateParams(candidateIdParamSchema),
  validateBody(candidateStatusUpdateSchema),
  async (req, res, next) => {
    try {
      const candidateId = req.params.candidateId as string;
      const target = req.body.status as CandidateStatus;
      const user = req.authUser!;

      const { data: candidate } = await supabase
        .from('candidates')
        .select('owner_id, status, decision_use_blocked_at')
        .eq('id', candidateId)
        .maybeSingle();
      if (!candidate) return res.status(404).json({ error: 'candidate_not_found' });
      if (user.appRole === 'interviewer' && candidate.owner_id !== user.id) {
        return res.status(403).json(forbiddenBody());
      }

      // Fail closed while an open appeal blocks decision-use.
      if (candidate.decision_use_blocked_at !== null) {
        return res.status(409).json({ error: 'decision_use_blocked' });
      }

      const from = candidate.status as string;
      const allowed = CANDIDATE_STATUS_TRANSITIONS[from as CandidateStatus];
      if (!allowed || !allowed.includes(target)) {
        return res.status(400).json({ error: 'invalid_status_transition', from, to: target });
      }

      // CAS: transition only when the current status is unchanged.
      const { data: updated, error } = await supabase
        .from('candidates')
        .update({ status: target })
        .eq('id', candidateId)
        .eq('status', from)
        .select('id');
      if (error) return next(new Error('failed to update candidate status'));
      if (!updated || updated.length === 0) {
        return res.status(409).json({ error: 'status_conflict' });
      }

      // Audit (DB-allowlisted action candidate_status_changed; direct insert —
      // the TS AuditEvent union is L2-owned and not extended in this lane).
      await supabase.from('audit_events').insert({
        actor_id: user.id,
        actor_type: 'recruiter',
        action: 'candidate_status_changed',
        target_type: 'candidate',
        target_id: candidateId,
        result: 'success',
        correlation_id: (req as { correlationId?: string | null }).correlationId ?? null,
        metadata: { from_status: from, to_status: target },
      });

      const body: StatusTransitionResponse = { ok: true, from, to: target };
      res.json(body);
    } catch (error) {
      next(error);
    }
  },
);
