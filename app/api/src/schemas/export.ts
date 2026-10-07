import { z } from 'zod';
import { uuidSchema } from './common.js';

/** GET /api/export/:candidateId/csv path param — UUID-derived safe filename. */
export const exportCandidateParamSchema = z.object({ candidateId: uuidSchema }).strict();

/**
 * POST /api/export/:candidateId/report-audit body. The report itself is built
 * in the browser; this only records THAT a stakeholder report was produced, so
 * the body carries counts and a flag, never content. `.strict()` rejects any
 * attempt to smuggle report content or free text into the audit row.
 */
export const exportReportAuditBodySchema = z
  .object({
    format: z.literal('html'),
    recordings: z.number().int().min(0).max(100),
    transcript: z.boolean(),
  })
  .strict();
