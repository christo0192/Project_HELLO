import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import {
  runAssessment,
  ERR_SESSION_NOT_COMPLETED,
  ERR_RESCORE_NO_SCORECARD,
} from '../services/assessment.js';
import { validateParams } from '../lib/validation.js';
import { assessSessionIdParamSchema, rescoreBodySchema } from '../schemas/assess.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';

export const assessRouter = Router();
export const workerAssessRouter = Router();

function requireWorkerAssessAuth(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): void {
  const configured = process.env.WORKER_CONTEXT_SECRET;
  if (!configured || configured.length < 32) {
    res.status(503).json({ ok: false, error: 'worker_auth_not_configured' });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'authentication_required' });
    return;
  }
  const supplied = Buffer.from(auth.slice(7), 'utf8');
  const expected = Buffer.from(configured, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.status(403).json({ ok: false, error: 'access_denied' });
    return;
  }
  next();
}

workerAssessRouter.post(
  '/:sessionId',
  requireWorkerAssessAuth,
  validateParams(assessSessionIdParamSchema),
  async (req, res, next) => {
    try {
      const assessment = await runAssessment(req.params.sessionId);
      res.json(assessment);
    } catch (error) {
      if (error instanceof Error && error.message === ERR_SESSION_NOT_COMPLETED) {
        return res.status(409).json({
          error: { type: 'session_not_completed', message: 'Session is not eligible for assessment' },
        });
      }
      next(error);
    }
  },
);

// SEC-03: Assessment scoring cannot be safely scoped by owner_id because
// sessions are candidate-centric. Only admin may trigger assessment.
assessRouter.post(
  '/:sessionId',
  requireRole('admin'),
  validateParams(assessSessionIdParamSchema),
  async (req, res, next) => {
    try {
      const assessment = await runAssessment(req.params.sessionId);
      // Audit: record resource create (assessment run)
      try {
        await recordAudit(req, 'resource.update', 200, {
          metadata: { session_id: req.params.sessionId },
        });
      } catch {
        return res.status(500).json({
          error: { type: 'internal_error', message: 'Internal server error' },
        });
      }
      res.json(assessment);
    } catch (error) {
      // VOI-08: ineligible sessions → stable non-retryable 409.
      // All other errors flow to the global error handler (500).
      if (error instanceof Error && error.message === ERR_SESSION_NOT_COMPLETED) {
        return res.status(409).json({
          error: { type: 'session_not_completed', message: 'Session is not eligible for assessment' },
        });
      }
      next(error);
    }
  },
);

// ── Phase 4: EXPLICIT IMMUTABLE RESCORE (admin) ───────────────────────
//
// Re-run scoring for a completed session against its role's CURRENT active v2
// scorecard, producing a NEW immutable assessment revision that supersedes the
// prior one. Idempotent per the caller-supplied `rescore_request_id`: a repeat
// with the same id returns the existing revision without re-scoring or writing
// a new row. A distinct sub-path keeps the first-score POST above byte-identical.
//
// SEC-03: like the first-score route, scoring cannot be safely scoped by
// owner_id (sessions are candidate-centric), so it is admin-only.
assessRouter.post(
  '/:sessionId/rescore',
  requireRole('admin'),
  validateParams(assessSessionIdParamSchema),
  async (req, res, next) => {
    const parsed = rescoreBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          type: 'invalid_request',
          message: 'rescore_request_id must be a valid UUID',
        },
      });
    }
    try {
      const assessment = await runAssessment(req.params.sessionId, {
        rescore: { requestId: parsed.data.rescore_request_id },
      });
      // Audit: the rescore is a privileged resource mutation (fail-closed).
      try {
        await recordAudit(req, 'resource.update', 200, {
          metadata: {
            session_id: req.params.sessionId,
            rescore_request_id: parsed.data.rescore_request_id,
          },
        });
      } catch {
        return res.status(500).json({
          error: { type: 'internal_error', message: 'Internal server error' },
        });
      }
      res.json(assessment);
    } catch (error) {
      // A rescore on a session that never completed → the same non-retryable 409.
      if (error instanceof Error && error.message === ERR_SESSION_NOT_COMPLETED) {
        return res.status(409).json({
          error: { type: 'session_not_completed', message: 'Session is not eligible for assessment' },
        });
      }
      // A role with no active v2 scorecard cannot be rescored → distinct 409.
      if (error instanceof Error && error.message === ERR_RESCORE_NO_SCORECARD) {
        return res.status(409).json({
          error: {
            type: 'rescore_requires_active_scorecard',
            message: 'Role has no active scorecard to rescore against',
          },
        });
      }
      next(error);
    }
  },
);
