/**
 * Phase 9 L3 — append-only recruiter notes + candidate status transitions.
 *
 * Invariant 2:
 * - recruiter_notes is append-only (UPDATE/direct DELETE blocked by the
 *   0015 trigger; only INSERT is possible through this API).
 * - Note body is bounded (1..2000 chars, matching the DB CHECK).
 * - Interviewer ownership / admin access; viewer read-only.
 * - A note can name a moment (0137): a round, an attempt of it, a time in its
 *   recording. The attempt must be the round's and the round the candidate's.
 *   That answers one way whether the round is missing or someone else's.
 * - Notes are human words: nothing here reaches any AI, and no route but this
 *   one and the scoped Ashby read touches the table (notes-stay-human.test.ts).
 * - Candidate status transitions use an explicit allowlist + CAS, write an
 *   audit row (candidate_status_changed), and fail closed while
 *   candidates.decision_use_blocked_at is set. Evidence/assessment fields
 *   are never touched and unknown statuses are never accepted.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole, requireInterviewer } from '../lib/rbac.js';
import { validateBody, validateQuery, validateParams } from '../lib/validation.js';
import { readAllPages, type PageResult } from '../lib/id-batches.js';
import {
  noteCreateSchema,
  noteListQuerySchema,
  candidateStatusUpdateSchema,
  candidateIdParamSchema,
  roundIdParamSchema,
  CANDIDATE_STATUS_TRANSITIONS,
  type CandidateStatus,
  type NoteListResponse,
  type NoteResponse,
  type StatusTransitionResponse,
} from '../schemas/notes.js';

export const notesRouter = Router();

const NOTE_COLUMNS = 'id, candidate_id, author_id, note, created_at, round_id, session_id, media_ms';

/** The most pages of one round's notes: 5,000 notes on one interview. Past that the read fails, never truncates. */
const MAX_ROUND_NOTE_PAGES = 5;

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

/**
 * Is this the candidate's round, and this one of its attempts? Asked by filter, so the database compares
 * the ids and a mismatch looks the same as a round that does not exist. `unavailable`: never guess.
 */
async function noteAnchorState(
  candidateId: string,
  roundId: string,
  sessionId: string | undefined,
): Promise<'ok' | 'invalid' | 'unavailable'> {
  const round = await supabase
    .from('interview_rounds')
    .select('id')
    .eq('id', roundId)
    .eq('candidate_id', candidateId)
    .maybeSingle();
  if (round.error) return 'unavailable';
  if (!round.data) return 'invalid';
  if (sessionId === undefined) return 'ok';

  const attempt = await supabase
    .from('interview_round_attempts')
    .select('session_id')
    .eq('round_id', roundId)
    .eq('session_id', sessionId)
    .maybeSingle();
  if (attempt.error) return 'unavailable';
  return attempt.data ? 'ok' : 'invalid';
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
        .select(NOTE_COLUMNS)
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

/**
 * GET /api/notes/rounds/:roundId — every note on one round, oldest first. The rule of /api/notes:
 * viewer and admin any candidate, an interviewer the candidates they own. As the R1 review does, a
 * missing round answers an interviewer the same 403 as someone else's, so an id tells them nothing.
 * Read through the candidate, on 0015's index, and paged, so a long list is never cut short.
 */
notesRouter.get(
  '/rounds/:roundId',
  requireRole('viewer'),
  validateParams(roundIdParamSchema),
  async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const user = req.authUser!;
      const { data: round, error: roundError } = await supabase
        .from('interview_rounds')
        .select('id, candidate_id')
        .eq('id', req.params.roundId as string)
        .maybeSingle();
      if (roundError) return next(new Error('failed to read the round'));
      if (!round) {
        if (user.appRole === 'interviewer') return res.status(403).json(forbiddenBody());
        return res.status(404).json({ error: 'round_not_found' });
      }

      const scope = await assertCandidateAccess(round.candidate_id, user);
      if (scope === 'not_found') return res.status(404).json({ error: 'round_not_found' });
      if (scope === 'forbidden') return res.status(403).json(forbiddenBody());

      const read = await readAllPages<NoteResponse>(
        (from, to) =>
          supabase
            .from('recruiter_notes')
            .select(NOTE_COLUMNS)
            .eq('candidate_id', round.candidate_id)
            .eq('round_id', round.id)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to) as unknown as PageResult,
        MAX_ROUND_NOTE_PAGES,
      );
      if (!read.ok) return next(new Error('failed to list notes'));

      const body: NoteListResponse = { notes: read.rows };
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
      const { candidate_id, note, round_id, session_id, media_ms } = req.body;
      const scope = await assertCandidateAccess(candidate_id, req.authUser!);
      if (scope === 'not_found') return res.status(404).json({ error: 'candidate_not_found' });
      if (scope === 'forbidden') return res.status(403).json(forbiddenBody());

      if (round_id !== undefined) {
        const anchor = await noteAnchorState(candidate_id, round_id, session_id);
        if (anchor === 'unavailable') return next(new Error('failed to check the note anchor'));
        if (anchor === 'invalid') return res.status(400).json({ error: 'invalid_note_anchor' });
      }

      const { data: record, error } = await supabase
        .from('recruiter_notes')
        .insert({
          candidate_id,
          author_id: req.authUser!.id,
          note,
          round_id: round_id ?? null,
          session_id: session_id ?? null,
          media_ms: media_ms ?? null,
        })
        .select(NOTE_COLUMNS)
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
