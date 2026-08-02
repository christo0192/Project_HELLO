/**
 * Phase 9 L3 — appeals (consistency #3/#4).
 *
 * - POST /api/appeals/grants — authenticated interviewer+/admin with
 *   candidate ownership; explicit bounded expiry required (no hidden policy
 *   default); returns plaintext ONCE; persists SHA-256 digest only.
 * - POST /api/appeals — public candidate submission (grant-authenticated).
 *   Validates the one-time grant inline, builds a MINIMIZED assessment
 *   snapshot (IDs/version hash/numeric scores/bands/recommendation only —
 *   no transcript/resume/contact/free-text/raw), then calls the migration's
 *   atomic create_appeal RPC which consumes the grant and sets
 *   decision_use_blocked_at. Replay fails stable.
 * - POST /api/appeals/:appealId/review — recruiter ownership/admin; legal
 *   CAS transitions only via the atomic review_appeal RPC (immutable
 *   appeal_review_events; block cleared only when no unresolved appeals).
 *   The API never accepts assessment_snapshot/"created" evidence mutations.
 * - GET /api/appeals?candidate_id= — recruiter list (viewer read-only).
 *
 * Router-level auth is NOT applied (POST /api/appeals is public — L4 adds
 * the exact PUBLIC_ROUTES entry); per-route middleware enforces roles.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { requireRole, requireInterviewer } from '../lib/rbac.js';
import { validateBody, validateQuery, validateParams } from '../lib/validation.js';
import {
  appealGrantCreateSchema,
  appealCreateSchema,
  appealListQuerySchema,
  appealReviewSchema,
  appealIdParamSchema,
} from '../schemas/appeals.js';
import {
  createAppealGrant,
  validateAppealGrant,
  hashAppealGrantToken,
} from '../lib/appeal-grant.js';

export const appealsRouter = Router();

function forbiddenBody(): { error: { type: string; message: string } } {
  return { error: { type: 'authorization_error', message: 'Insufficient permissions' } };
}

/** Extract a numeric score from an assessment dimension. */
function numericScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.score === 'number' && Number.isFinite(obj.score)) return obj.score;
    const nums = Object.values(obj).filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
    if (nums.length > 0) {
      return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
    }
  }
  return null;
}

/**
 * Minimized assessment snapshot: IDs + version hash + numeric scores/bands +
 * recommendation ONLY. NEVER transcript/resume/contact/free-text/raw.
 */
function buildAssessmentSnapshot(a: {
  id: string;
  english?: unknown;
  tone?: unknown;
  communication?: unknown;
  motivation?: unknown;
  role_fit?: unknown;
  overall_score?: unknown;
  recommendation?: unknown;
}): Record<string, unknown> {
  const overall = Number(a.overall_score);
  const scores = {
    english: numericScore(a.english),
    tone: numericScore(a.tone),
    role_fit: numericScore(a.role_fit),
    communication: numericScore(a.communication),
    motivation: numericScore(a.motivation),
    overall_score: Number.isFinite(overall) ? overall : null,
    recommendation: typeof a.recommendation === 'string' ? a.recommendation : null,
  };
  const versionHash = createHash('sha256')
    .update(JSON.stringify({ assessment_id: a.id, scores }))
    .digest('hex');
  return { assessment_id: a.id, version_hash: versionHash, scores };
}

/**
 * POST /api/appeals/grants
 * Interviewer+/admin with candidate ownership; explicit bounded expiry.
 * Plaintext token returned once; only SHA-256 digest persisted.
 */
appealsRouter.post(
  '/grants',
  requireInterviewer,
  validateBody(appealGrantCreateSchema),
  async (req, res, next) => {
    try {
      const { candidate_id, session_id, expires_in_hours } = req.body;
      const user = req.authUser!;

      const { data: candidate } = await supabase
        .from('candidates')
        .select('owner_id')
        .eq('id', candidate_id)
        .maybeSingle();
      if (!candidate) return res.status(404).json({ error: 'candidate_not_found' });
      if (user.appRole === 'interviewer' && candidate.owner_id !== user.id) {
        return res.status(403).json(forbiddenBody());
      }

      const { data: session } = await supabase
        .from('call_sessions')
        .select('candidate_id')
        .eq('id', session_id)
        .maybeSingle();
      if (!session) return res.status(404).json({ error: 'session_not_found' });
      if (session.candidate_id !== candidate_id) {
        return res.status(400).json({ error: 'candidate_session_mismatch' });
      }

      const expiresAt = new Date(Date.now() + expires_in_hours * 3600 * 1000);
      const { token, expires_at } = await createAppealGrant({
        candidate_id,
        session_id,
        created_by: user.id,
        expires_at: expiresAt.toISOString(),
      });

      res.status(201).json({ appeal_grant_token: token, expires_at });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/appeals?candidate_id=
 * Recruiter list (viewer read-only; interviewer owns; admin all).
 */
appealsRouter.get(
  '/',
  requireRole('viewer'),
  validateQuery(appealListQuerySchema),
  async (req, res, next) => {
    try {
      const candidateId = req.query.candidate_id as string;
      const user = req.authUser!;
      if (user.appRole === 'interviewer') {
        const { data: candidate } = await supabase
          .from('candidates')
          .select('owner_id')
          .eq('id', candidateId)
          .maybeSingle();
        if (!candidate) return res.status(404).json({ error: 'candidate_not_found' });
        if (candidate.owner_id !== user.id) return res.status(403).json(forbiddenBody());
      }
      const { data, error } = await supabase
        .from('appeal_requests')
        .select(
          'id, candidate_id, session_id, assessment_id, category, description, status, created_at, updated_at',
        )
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: false });
      if (error) return next(new Error('failed to list appeals'));
      res.json({ appeals: data ?? [] });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/appeals — public candidate submission (grant-authenticated).
 * Validates the one-time grant inline, builds the minimized snapshot
 * server-side, and calls the atomic create_appeal RPC (consumes grant +
 * sets decision_use_blocked_at). Replay fails stable.
 */
appealsRouter.post('/', validateBody(appealCreateSchema), async (req, res, next) => {
  try {
    const { appeal_grant_token, category, description } = req.body;

    const validation = await validateAppealGrant(appeal_grant_token);
    if (!validation.ok) {
      // Stable: never distinguish invalid/expired/revoked/consumed here.
      return res.status(404).json({ error: 'appeal_grant_invalid_or_expired' });
    }
    const { candidate_id, session_id } = validation.grant;

    const { data: assessment } = await supabase
      .from('assessments')
      .select('id, english, tone, communication, motivation, role_fit, overall_score, recommendation')
      .eq('session_id', session_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!assessment) return res.status(409).json({ error: 'no_assessment_for_appeal' });

    // Server-built minimized snapshot — the client never supplies it.
    const snapshot = buildAssessmentSnapshot(assessment);

    const { data, error } = await supabase.rpc('create_appeal', {
      p_candidate_id: candidate_id,
      p_session_id: session_id,
      p_assessment_id: assessment.id,
      p_grant_digest: hashAppealGrantToken(appeal_grant_token),
      p_category: category,
      p_description: description,
      p_assessment_snapshot: snapshot,
    });
    if (error) return next(new Error('failed to create appeal'));

    const record = data as { status?: string; appeal_id?: string } | null;
    switch (record?.status) {
      case 'ok':
        return res.status(201).json({ ok: true, appeal_id: record.appeal_id });
      case 'grant_consumed':
        return res.status(409).json({ error: 'appeal_grant_consumed' });
      case 'grant_revoked':
        return res.status(409).json({ error: 'appeal_grant_revoked' });
      case 'grant_expired':
        return res.status(409).json({ error: 'appeal_grant_expired' });
      case 'grant_mismatch':
        return res.status(409).json({ error: 'appeal_grant_mismatch' });
      case 'grant_not_found':
        return res.status(404).json({ error: 'appeal_grant_invalid_or_expired' });
      case 'invalid_grant_digest':
      case 'invalid_category':
      case 'invalid_description':
      case 'invalid_snapshot':
        return res.status(400).json({ error: record.status });
      default:
        return next(new Error('appeal creation failed'));
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/appeals/:appealId/review
 * Recruiter ownership/admin; legal CAS transitions only via the atomic
 * review_appeal RPC (immutable appeal_review_events; block cleared only
 * when no unresolved appeals remain). Never mutates the original issue
 * description or assessment snapshot.
 */
appealsRouter.post(
  '/:appealId/review',
  requireInterviewer,
  validateParams(appealIdParamSchema),
  validateBody(appealReviewSchema),
  async (req, res, next) => {
    try {
      const appealId = req.params.appealId as string;
      const user = req.authUser!;

      const { data: appeal } = await supabase
        .from('appeal_requests')
        .select('candidate_id')
        .eq('id', appealId)
        .maybeSingle();
      if (!appeal) return res.status(404).json({ error: 'appeal_not_found' });
      if (user.appRole === 'interviewer') {
        const { data: candidate } = await supabase
          .from('candidates')
          .select('owner_id')
          .eq('id', appeal.candidate_id)
          .maybeSingle();
        if (!candidate || candidate.owner_id !== user.id) {
          return res.status(403).json(forbiddenBody());
        }
      }

      const { data, error } = await supabase.rpc('review_appeal', {
        p_appeal_id: appealId,
        p_reviewer_id: user.id,
        p_to_status: req.body.to_status,
        p_notes: req.body.notes ?? null,
        p_evidence: req.body.evidence ?? null,
      });
      if (error) return next(new Error('failed to review appeal'));

      const status = (data as { status?: string } | null)?.status;
      switch (status) {
        case 'ok':
        case 'no_op':
          return res.json({ ok: true });
        case 'appeal_not_found':
          return res.status(404).json({ error: 'appeal_not_found' });
        case 'already_final':
          return res.status(409).json({ error: 'appeal_already_final' });
        case 'invalid_transition':
          return res.status(400).json({ error: 'invalid_transition' });
        case 'invalid_target':
          return res.status(400).json({ error: 'invalid_target' });
        case 'invalid_notes':
        case 'invalid_evidence':
          return res.status(400).json({ error: status });
        default:
          return next(new Error('appeal review failed'));
      }
    } catch (error) {
      next(error);
    }
  },
);
