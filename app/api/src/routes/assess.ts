import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { runAssessment, ERR_SESSION_NOT_COMPLETED } from '../services/assessment.js';
import { validateParams } from '../lib/validation.js';
import { assessSessionIdParamSchema } from '../schemas/assess.js';
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
