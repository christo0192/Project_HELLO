import { z } from 'zod';

// ── POST /api/assess/:sessionId ───────────────────────────────────

export const assessSessionIdParamSchema = z
  .object({
    sessionId: z.string().uuid('sessionId must be a valid UUID'),
  })
  .strict();
