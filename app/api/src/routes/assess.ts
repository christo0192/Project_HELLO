import { Router } from 'express';
import { runAssessment, ERR_SESSION_NOT_COMPLETED } from '../services/assessment.js';
import { validateParams } from '../lib/validation.js';
import { assessSessionIdParamSchema } from '../schemas/assess.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';

export const assessRouter = Router();

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
