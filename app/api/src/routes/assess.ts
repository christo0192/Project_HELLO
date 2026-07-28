import { Router } from 'express';
import { runAssessment } from '../services/assessment.js';
import { validateParams } from '../lib/validation.js';
import { assessSessionIdParamSchema } from '../schemas/assess.js';

export const assessRouter = Router();

// POST /api/assess/:sessionId  -> (re)run scoring for a session
assessRouter.post(
  '/:sessionId',
  validateParams(assessSessionIdParamSchema),
  async (req, res, next) => {
    try {
      const assessment = await runAssessment(req.params.sessionId);
      res.json(assessment);
    } catch (error) {
      next(error);
    }
  },
);
