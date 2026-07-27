import { Router } from 'express';
import { runAssessment } from '../services/assessment.js';

export const assessRouter = Router();

// POST /api/assess/:sessionId  -> (re)run scoring for a session
assessRouter.post('/:sessionId', async (req, res) => {
  try {
    const assessment = await runAssessment(req.params.sessionId);
    res.json(assessment);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'assessment failed' });
  }
});
