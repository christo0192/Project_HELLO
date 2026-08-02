import { z } from 'zod';
import { uuidSchema } from './common.js';

/** GET /api/export/:candidateId/csv path param — UUID-derived safe filename. */
export const exportCandidateParamSchema = z.object({ candidateId: uuidSchema }).strict();
